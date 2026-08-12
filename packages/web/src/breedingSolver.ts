import type { SaveBreedingPal } from "@palserver/shared";

export type BreedingGender = "*" | "m" | "f";
export type BreedingRecipe = [string, BreedingGender, string, BreedingGender, string];

export interface BreedingData {
  source: string;
  license: string;
  version: string;
  recipes: BreedingRecipe[];
}

export interface BreedingNode {
  species: string;
  gender: BreedingGender;
  passiveMask: number;
  generation: number;
  breedCount: number;
  captureCount: number;
  requiredCapture?: true;
  source?: SaveBreedingPal;
  parents?: readonly [BreedingNode, BreedingNode];
}

export interface BreedingSolution {
  target: BreedingNode | null;
  routes: BreedingRoute[];
  reachableSpecies: number;
  requiredCaptures: BreedingNode[];
}

export interface BreedingRoute {
  target: BreedingNode;
  requiredCaptures: BreedingNode[];
}

const MAX_ALTERNATIVE_ROUTES = 5;

function canonicalSpecies(id: string, names: Map<string, string>): string {
  const bare = id.replace(/^BOSS_/i, "");
  return names.get(bare.toLowerCase()) ?? bare;
}

function maskFor(passives: string[], desired: string[]): number {
  let mask = 0;
  for (let i = 0; i < desired.length; i++) {
    if (passives.includes(desired[i])) mask |= 1 << i;
  }
  return mask;
}

function stateKey(node: Pick<BreedingNode, "species" | "gender" | "passiveMask">): string {
  return `${node.species}\u0000${node.gender}\u0000${node.passiveMask}`;
}

function sourceScore(node: BreedingNode): number {
  if (!node.source) return 0;
  const location = { palbox: 4, base: 3, party: 2, unknown: 1 }[node.source.location];
  return (
    location * 1_000_000 +
    (node.source.talentHp ?? 0) +
    (node.source.talentShot ?? 0) +
    (node.source.talentDefense ?? 0)
  );
}

function compareNodes(a: BreedingNode, b: BreedingNode): number {
  return (
    a.captureCount - b.captureCount ||
    a.generation - b.generation ||
    a.breedCount - b.breedCount ||
    sourceScore(b) - sourceScore(a)
  );
}

const routeKeyCache = new WeakMap<BreedingNode, string>();

function routeKey(node: BreedingNode): string {
  const cached = routeKeyCache.get(node);
  if (cached) return cached;
  let key: string;
  // 路線描述的是物種與詞條的配種思路；個體和性別只用來選出一組實際可配的親代，
  // 不應讓同一棵物種樹重複佔用候選名額。
  if (node.source) key = `source:${node.species}:${node.passiveMask}`;
  else if (node.requiredCapture) key = `capture:${node.species}`;
  else if (!node.parents) key = `${node.species}:${node.gender}:${node.passiveMask}`;
  else key = `${node.species}:${node.gender}:${node.passiveMask}(${routeKey(node.parents[0])}+${routeKey(node.parents[1])})`;
  routeKeyCache.set(node, key);
  return key;
}

function matchesGender(actual: BreedingGender, required: BreedingGender): boolean {
  return actual === "*" || required === "*" || actual === required;
}

function compatibleParents(a: BreedingNode, requiredA: BreedingGender, b: BreedingNode, requiredB: BreedingGender): boolean {
  if (!matchesGender(a.gender, requiredA) || !matchesGender(b.gender, requiredB)) return false;
  if (a.source && b.source && a.source.instanceId === b.source.instanceId) return false;

  const genderA = requiredA === "*" ? a.gender : requiredA;
  const genderB = requiredB === "*" ? b.gender : requiredB;
  return genderA === "*" || genderB === "*" || genderA !== genderB;
}

/**
 * PalCalc 配方上的有界動態規劃。普通路線先最小化最長代數,再最小化整棵樹的配種次數;
 * 補充路線先最小化需捕捉數。詞條按「雙親詞條去重後繼承」合併,新生帕魯可孵出任一性別。
 */
export function solveBreeding(
  data: BreedingData,
  owned: SaveBreedingPal[],
  targetId: string,
  desiredPassives: string[],
  maxGenerations: number,
  onProgress?: (routes: BreedingRoute[]) => void,
): BreedingSolution {
  const canonical = new Map<string, string>();
  for (const [p1, , p2, , child] of data.recipes) {
    canonical.set(p1.toLowerCase(), p1);
    canonical.set(p2.toLowerCase(), p2);
    canonical.set(child.toLowerCase(), child);
  }

  const targetSpecies = canonicalSpecies(targetId, canonical);
  const fullMask = (1 << desiredPassives.length) - 1;
  const routeFor = (target: BreedingNode): BreedingRoute => {
    const captures = new Map<string, BreedingNode>();
    const collectCaptures = (node: BreedingNode) => {
      if (node.requiredCapture) captures.set(`${node.species}\u0000${node.gender}`, node);
      node.parents?.forEach(collectCaptures);
    };
    collectCaptures(target);
    return { target, requiredCaptures: [...captures.values()] };
  };

  const search = (allowCaptures: boolean) => {
    const states = new Map<string, BreedingNode[]>();
    const discoveredTargets: BreedingNode[] = [];
    const discoveredKeys = new Set<string>();
    let reportedCount = 0;
    const add = (node: BreedingNode, dest = states) => {
      const key = stateKey(node);
      const current = dest.get(key) ?? [];
      const signature = routeKey(node);
      const distinct = current.filter((candidate) => routeKey(candidate) !== signature);
      dest.set(key, [...distinct, node].sort(compareNodes).slice(0, MAX_ALTERNATIVE_ROUTES));
      if (
        onProgress &&
        node.species === targetSpecies &&
        node.passiveMask === fullMask &&
        node.parents &&
        !discoveredKeys.has(signature)
      ) {
        discoveredKeys.add(signature);
        discoveredTargets.push(node);
        discoveredTargets.sort(compareNodes);
        if (reportedCount < MAX_ALTERNATIVE_ROUTES && discoveredTargets.length > reportedCount) {
          reportedCount += 1;
          onProgress(discoveredTargets.slice(0, reportedCount).map(routeFor));
        }
      }
    };

    for (const pal of owned) {
      if (!pal.gender) continue;
      add({
        species: canonicalSpecies(pal.characterId, canonical),
        gender: pal.gender === "male" ? "m" : "f",
        passiveMask: maskFor(pal.passives, desiredPassives),
        generation: 0,
        breedCount: 0,
        captureCount: 0,
        source: pal,
      });
    }

    if (allowCaptures) {
      for (const species of new Set(canonical.values())) {
        // 補充路線應說明要抓哪些親代,而不是退化成「直接捕捉目標」。
        if (species === targetSpecies) continue;
        for (const gender of ["m", "f"] as const) {
          add({
            species,
            gender,
            passiveMask: 0,
            generation: 0,
            breedCount: 0,
            captureCount: 1,
            requiredCapture: true,
          });
        }
      }
    }

    for (let generation = 1; generation <= Math.max(0, maxGenerations); generation++) {
      const bySpecies = new Map<string, BreedingNode[]>();
      for (const candidates of states.values()) {
        for (const node of candidates) {
          const list = bySpecies.get(node.species) ?? [];
          list.push(node);
          bySpecies.set(node.species, list);
        }
      }
      const staged = new Map<string, BreedingNode[]>();

      for (const [parent1, gender1, parent2, gender2, child] of data.recipes) {
        const left = bySpecies.get(parent1);
        const right = bySpecies.get(parent2);
        if (!left || !right) continue;
        for (const a of left) {
          for (const b of right) {
            if (!compatibleParents(a, gender1, b, gender2)) continue;
            const childGeneration = Math.max(a.generation, b.generation) + 1;
            if (childGeneration !== generation) continue;
            add(
              {
                species: child,
                gender: "*",
                passiveMask: a.passiveMask | b.passiveMask,
                generation: childGeneration,
                breedCount: a.breedCount + b.breedCount + 1,
                captureCount: a.captureCount + b.captureCount,
                parents: [a, b],
              },
              staged,
            );
          }
        }
      }
      for (const candidates of staged.values()) {
        for (const node of candidates) add(node);
      }
    }

    const candidates = [...states.values()].flat().filter(
      (node) =>
        node.species === targetSpecies &&
        node.passiveMask === fullMask &&
        Boolean(node.parents),
    );
    candidates.sort(compareNodes);
    return { targets: candidates.slice(0, MAX_ALTERNATIVE_ROUTES), states };
  };

  const ownedOnly = search(false);
  const targets = ownedOnly.targets.length > 0 ? ownedOnly.targets : search(true).targets;
  const routes = targets.map(routeFor);
  const primary = routes[0];

  return {
    target: primary?.target ?? null,
    routes,
    reachableSpecies: new Set([...ownedOnly.states.values()].flat().map((node) => node.species)).size,
    requiredCaptures: primary?.requiredCaptures ?? [],
  };
}
