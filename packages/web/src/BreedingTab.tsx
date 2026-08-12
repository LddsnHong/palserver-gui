import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiBookmark, FiChevronDown, FiCrosshair, FiGitBranch, FiMapPin, FiMaximize2, FiRefreshCw, FiSearch, FiTrash2, FiZoomIn, FiZoomOut } from "react-icons/fi";
import { GiEggClutch } from "react-icons/gi";
import { hasFeature, savToMap, type SaveBreedingPal } from "@palserver/shared";
import type { AgentClient } from "./api";
import { EntityPicker } from "./EntityPicker";
import { MultiPicker } from "./MultiPicker";
import { displayName, palIconUrl, useGameData, type GameData } from "./gameData";
import type { BreedingData, BreedingNode, BreedingRoute, BreedingSolution } from "./breedingSolver";
import { t, useI18n } from "./i18n";
import { EmptyState, SponsorLockNotice, btn, btnGhost, card, errorCls, labelCls, Select } from "./ui";

let recipesCache: BreedingData | null = null;
const PASSIVE_PRESETS_KEY = "palserver.breeding.passivePresets";

function loadPassivePresets(): string[][] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PASSIVE_PRESETS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((preset): preset is string[] =>
        Array.isArray(preset) &&
        preset.length > 0 &&
        preset.length <= 4 &&
        preset.every((id) => typeof id === "string" && id.length > 0),
      )
      .map((preset) => [...new Set(preset)]);
  } catch {
    return [];
  }
}

function passivePresetKey(ids: string[]): string {
  return [...ids].sort().join("\u0000");
}

async function loadBreedingData(): Promise<BreedingData> {
  if (recipesCache) return recipesCache;
  const response = await fetch("/game-data/breeding.json");
  if (!response.ok) throw new Error(`breeding.json: HTTP ${response.status}`);
  recipesCache = (await response.json()) as BreedingData;
  return recipesCache;
}

const locationLabel: Record<SaveBreedingPal["location"], string> = {
  party: "隊伍",
  palbox: "帕魯箱",
  base: "據點",
  unknown: "未知位置",
};

const PALBOX_SLOTS_PER_PAGE = 30;

function sourceLocation(source: SaveBreedingPal): string {
  if (source.location === "palbox" && source.slotIndex != null) {
    return t("帕魯箱第 {page} 頁", { page: Math.floor(source.slotIndex / PALBOX_SLOTS_PER_PAGE) + 1 });
  }
  if (source.location === "base" && source.base) {
    const generatedName = /^(新規生成拠点|新规生成据点|新規生成據點)/.test(source.base.name);
    return source.base.name && !generatedName
      ? t("據點:{base}", { base: source.base.name })
      : t("公會據點");
  }
  return t(locationLabel[source.location]);
}

function sourceSummary(source: SaveBreedingPal): string {
  return t("{owner} · {location}", {
    owner: source.ownerName,
    location: sourceLocation(source),
  });
}

function speciesId(id: string): string {
  return id.replace(/^BOSS_/i, "");
}

function palName(data: GameData | null, id: string): string {
  const entity = data?.palByIdLower.get(speciesId(id).toLowerCase());
  return entity ? displayName(entity) : id;
}

function passiveIds(node: BreedingNode, desired: string[]): string[] {
  if (node.source) return node.source.passives.filter((id) => desired.includes(id));
  return desired.filter((_, index) => (node.passiveMask & (1 << index)) !== 0);
}

function PalTreeNode({
  node,
  data,
  desired,
  target,
  onShowOnMap,
}: {
  node: BreedingNode;
  data: GameData | null;
  desired: string[];
  target?: boolean;
  onShowOnMap?: (x: number, y: number) => void;
}) {
  const entity = data?.palByIdLower.get(speciesId(node.species).toLowerCase());
  const source = node.source;
  const matching = passiveIds(node, desired);
  return (
    <div className={`flex h-[116px] w-[240px] gap-2 overflow-hidden rounded-lg border-2 p-3 shadow-(--shadow-cute) ${node.requiredCapture ? "border-sun bg-sun/10" : target ? "border-pal bg-card" : "border-line bg-card"}`}>
      <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-line bg-card-soft">
        {entity?.icon && <img src={palIconUrl(entity.icon)} alt="" className="size-full object-contain" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-baseline gap-1.5 text-sm font-extrabold">
          <span className="truncate">{source?.nickname || palName(data, node.species)}</span>
          <span className="shrink-0 text-xs font-normal text-ink-muted">
            {node.gender === "m" ? "♂" : node.gender === "f" ? "♀" : "♂/♀"}
          </span>
          {source && (
            <span className="ml-auto shrink-0 text-[10px] font-bold text-ink-muted">
              Lv.{source.level ?? "—"}
            </span>
          )}
        </p>
        {source?.base && onShowOnMap ? (
          <button
            type="button"
            className="flex max-w-full items-center gap-1 text-left text-[11px] text-ink-muted transition hover:text-pal"
            title={`${sourceSummary(source)} · ${t("在地圖上查看")}`}
            onClick={() => {
              const point = savToMap(source.base!.x, source.base!.y);
              onShowOnMap(point.x, point.y);
            }}
          >
            <FiMapPin className="size-3 shrink-0" />
            <span className="truncate">{sourceSummary(source)}</span>
          </button>
        ) : (
          <p className="truncate text-[11px] text-ink-muted" title={source ? sourceSummary(source) : undefined}>
            {node.requiredCapture
              ? t("需捕捉")
              : source
                ? sourceSummary(source)
                : t("第 {n} 代配種結果", { n: node.generation })}
          </p>
        )}
        {source && (
          <p className="mt-1 truncate text-[10px] font-bold text-ink-muted">
            HP {source.talentHp ?? "—"} · ATK {source.talentShot ?? "—"} · DEF {source.talentDefense ?? "—"}
          </p>
        )}
        {matching.length > 0 && (
          <div className="mt-1.5 flex max-h-10 flex-wrap gap-1 overflow-hidden">
            {matching.map((id) => (
              <span key={id} className="max-w-full truncate rounded-sm border-l-3 border-pal bg-pal/10 px-1.5 py-0.5 text-[10px] font-bold text-ink">
                {data?.passiveById.get(id) ? displayName(data.passiveById.get(id)!) : id}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const TREE_NODE_WIDTH = 240;
const TREE_NODE_HEIGHT = 116;
const TREE_COLUMN_GAP = 96;
const TREE_ROW_GAP = 24;
const TREE_PADDING = 24;

interface TreeNodeLayout {
  id: string;
  node: BreedingNode;
  x: number;
  y: number;
}

interface TreeEdgeLayout {
  from: TreeNodeLayout;
  to: TreeNodeLayout;
}

function layoutBreedingTree(target: BreedingNode) {
  const nodes: TreeNodeLayout[] = [];
  const edges: TreeEdgeLayout[] = [];
  let leafIndex = 0;

  const visit = (node: BreedingNode, id: string): TreeNodeLayout => {
    let y: number;
    let parents: TreeNodeLayout[] = [];
    if (node.parents) {
      parents = [visit(node.parents[0], `${id}-0`), visit(node.parents[1], `${id}-1`)];
      y = (parents[0].y + parents[1].y) / 2;
    } else {
      y = TREE_PADDING + leafIndex * (TREE_NODE_HEIGHT + TREE_ROW_GAP);
      leafIndex += 1;
    }
    const current = {
      id,
      node,
      x: TREE_PADDING + node.generation * (TREE_NODE_WIDTH + TREE_COLUMN_GAP),
      y,
    };
    nodes.push(current);
    for (const parent of parents) edges.push({ from: parent, to: current });
    return current;
  };

  visit(target, "target");
  return {
    nodes,
    edges,
    width: TREE_PADDING * 2 + (target.generation + 1) * TREE_NODE_WIDTH + target.generation * TREE_COLUMN_GAP,
    height: TREE_PADDING * 2 + Math.max(1, leafIndex) * TREE_NODE_HEIGHT + Math.max(0, leafIndex - 1) * TREE_ROW_GAP,
  };
}

function BreedingTree({ target, data, desired, captureCount, onShowOnMap }: { target: BreedingNode; data: GameData | null; desired: string[]; captureCount: number; onShowOnMap?: (x: number, y: number) => void }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => layoutBreedingTree(target), [target]);
  const [zoom, setZoom] = useState(1);

  useEffect(() => setZoom(1), [target]);

  const fit = () => {
    const available = viewportRef.current?.clientWidth ?? layout.width;
    setZoom(Math.max(0.25, Math.min(1, (available - 20) / layout.width)));
    viewportRef.current?.scrollTo({ left: 0, top: 0, behavior: "smooth" });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="inline-flex items-center gap-2 text-base font-extrabold">
            <FiGitBranch className="size-5 text-pal" /> {t("配種路徑")}
          </h3>
          <p className="mt-0.5 text-xs text-ink-muted">
            {captureCount > 0
              ? t("{generations} 代 · 共 {steps} 次配種 · 需捕捉 {captures} 隻", { generations: target.generation, steps: target.breedCount, captures: captureCount })
              : t("{generations} 代 · 共 {steps} 次配種", { generations: target.generation, steps: target.breedCount })}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button className={`${btnGhost} !px-3`} onClick={() => setZoom((value) => Math.max(0.25, value - 0.15))} aria-label={t("縮小")} title={t("縮小")}>
            <FiZoomOut className="size-4" />
          </button>
          <span className="w-12 text-center text-xs font-bold text-ink-muted">{Math.round(zoom * 100)}%</span>
          <button className={`${btnGhost} !px-3`} onClick={() => setZoom((value) => Math.min(1.4, value + 0.15))} aria-label={t("放大")} title={t("放大")}>
            <FiZoomIn className="size-4" />
          </button>
          <button className={`${btnGhost} !px-3`} onClick={fit} aria-label={t("符合寬度")} title={t("符合寬度")}>
            <FiMaximize2 className="size-4" />
          </button>
        </div>
      </div>
      <div
        ref={viewportRef}
        className="overflow-auto rounded-lg border-2 border-line bg-card-soft"
        style={{ height: Math.min(680, Math.max(300, layout.height * zoom + 4)) }}
      >
        <div className="relative" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
          <div
            className="absolute top-0 left-0 origin-top-left"
            style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}
          >
            <svg className="absolute inset-0 size-full" aria-hidden="true">
              <defs>
                <marker id="breeding-tree-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-ink-muted)" />
                </marker>
              </defs>
              {layout.edges.map(({ from, to }) => {
                const x1 = from.x + TREE_NODE_WIDTH;
                const y1 = from.y + TREE_NODE_HEIGHT / 2;
                const x2 = to.x;
                const y2 = to.y + TREE_NODE_HEIGHT / 2;
                const bend = Math.max(36, (x2 - x1) * 0.45);
                return (
                  <path
                    key={`${from.id}-${to.id}`}
                    d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    stroke="var(--color-ink-muted)"
                    strokeOpacity="0.65"
                    strokeWidth="2"
                    markerEnd="url(#breeding-tree-arrow)"
                  />
                );
              })}
            </svg>
            {layout.nodes.map((entry) => (
              <div key={entry.id} className="absolute" style={{ left: entry.x, top: entry.y }}>
                <PalTreeNode node={entry.node} data={data} desired={desired} target={entry.node === target} onShowOnMap={onShowOnMap} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

interface BreedingHistoryEntry {
  id: number;
  targetId: string;
  desired: string[];
  ownerUid: string;
  maxGenerations: number;
  solution: BreedingSolution;
}

type BreedingWorkerResponse =
  | { type: "progress"; routes: BreedingRoute[] }
  | { type: "complete"; solution: BreedingSolution }
  | { type: "error"; error: string };

function BreedingRoutePanel({
  route,
  index,
  data,
  desired,
  defaultOpen,
  onShowOnMap,
}: {
  route: BreedingRoute;
  index: number;
  data: GameData | null;
  desired: string[];
  defaultOpen: boolean;
  onShowOnMap?: (x: number, y: number) => void;
}) {
  const { target, requiredCaptures } = route;
  return (
    <details className={`${card} group`} open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center gap-3 [&::-webkit-details-marker]:hidden">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full border-2 border-pal/40 bg-pal/10 text-sm font-extrabold text-pal">{index + 1}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-extrabold">{t("配種路線 {n}", { n: index + 1 })}</span>
          <span className="block text-xs text-ink-muted">
            {requiredCaptures.length > 0
              ? t("{generations} 代 · 共 {steps} 次配種 · 需捕捉 {captures} 隻", {
                  generations: target.generation,
                  steps: target.breedCount,
                  captures: requiredCaptures.length,
                })
              : t("{generations} 代 · 共 {steps} 次配種", {
                  generations: target.generation,
                  steps: target.breedCount,
                })}
          </span>
        </span>
        <FiChevronDown className="size-5 shrink-0 text-ink-muted transition group-open:rotate-180" />
      </summary>

      <div className="mt-4 border-t-2 border-line pt-4">
        {requiredCaptures.length > 0 && (
          <div className="mb-4 rounded-md border-2 border-sun/50 bg-sun/10 p-4">
            <p className="inline-flex items-center gap-2 text-sm font-extrabold text-ink">
              <FiCrosshair className="size-4 text-sun" />
              {t("現有帕魯不足，補充捕捉 {n} 隻帕魯後可配種", { n: requiredCaptures.length })}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {requiredCaptures.map((node) => (
                <span key={`${node.species}-${node.gender}`} className="inline-flex items-center gap-1.5 rounded-md border border-sun/60 bg-card px-2 py-1 text-xs font-bold text-ink">
                  {palName(data, node.species)}
                  <span className="text-ink-muted">{node.gender === "m" ? "♂" : "♀"}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {target.generation > 0 && (
          <BreedingTree
            target={target}
            data={data}
            desired={desired}
            captureCount={requiredCaptures.length}
            onShowOnMap={onShowOnMap}
          />
        )}
      </div>
    </details>
  );
}

export function BreedingTab({ client, instanceId, onShowOnMap }: { client: AgentClient; instanceId: string; onShowOnMap?: (x: number, y: number) => void }) {
  useI18n();
  const gameData = useGameData();
  const [breedingData, setBreedingData] = useState<BreedingData | null>(null);
  const [pals, setPals] = useState<SaveBreedingPal[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [worldGuid, setWorldGuid] = useState<string | null>(null);
  const [canScan, setCanScan] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [targetId, setTargetId] = useState("");
  const [passives, setPassives] = useState<string[]>([]);
  const [passivePresets, setPassivePresets] = useState<string[][]>(loadPassivePresets);
  const [ownerUid, setOwnerUid] = useState("");
  const [maxGenerations, setMaxGenerations] = useState(4);
  const [calculating, setCalculating] = useState(false);
  const [history, setHistory] = useState<BreedingHistoryEntry[]>([]);
  const [activeHistoryId, setActiveHistoryId] = useState<number | null>(null);
  const [entitled, setEntitled] = useState<boolean | null>(null);
  const scanTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const calculationRun = useRef(0);
  const cancelCalculation = useRef<(() => void) | null>(null);
  const nextHistoryId = useRef(1);
  const invalidateDraft = useCallback(() => {
    calculationRun.current += 1;
    cancelCalculation.current?.();
    cancelCalculation.current = null;
    setCalculating(false);
    setActiveHistoryId(null);
  }, []);

  useEffect(() => {
    client
      .license()
      .then((l) => setEntitled(hasFeature("breeding-calc", l)))
      .catch(() => setEntitled(false));
  }, [client]);
  useEffect(
    () => () => {
      if (scanTimer.current) clearInterval(scanTimer.current);
      cancelCalculation.current?.();
    },
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [snapshot, recipes] = await Promise.all([
        client.breedingSnapshot(instanceId),
        loadBreedingData(),
      ]);
      setBreedingData(recipes);
      setPals(snapshot.pals);
      setGeneratedAt(snapshot.generatedAt);
      setWorldGuid(snapshot.worldGuid);
      setHistory([]);
      setActiveHistoryId(null);
      setError(null);
      try {
        setCanScan((await client.saveHealth(instanceId, snapshot.worldGuid)).supported);
      } catch {
        setCanScan(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client, instanceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const owners = useMemo(() => {
    const map = new Map<string, string>();
    for (const pal of pals) {
      if (!pal.base) map.set(pal.ownerUid, pal.ownerName);
    }
    return [...map].sort((a, b) => a[1].localeCompare(b[1]));
  }, [pals]);
  const available = useMemo(() => {
    if (!ownerUid) return pals;
    const normalizeId = (id: string) => id.replace(/[^0-9a-f]/gi, "").toLowerCase();
    const guildIds = new Set(
      pals
        .filter((pal) => !pal.base && pal.ownerUid === ownerUid && pal.ownerGuildId)
        .map((pal) => normalizeId(pal.ownerGuildId!)),
    );
    return pals.filter(
      (pal) =>
        pal.ownerUid === ownerUid ||
        (pal.base !== undefined && guildIds.has(normalizeId(pal.base.guildId))),
    );
  }, [ownerUid, pals]);

  const scan = async () => {
    if (!worldGuid) return;
    setScanning(true);
    setError(null);
    try {
      await client.startSaveHealth(instanceId, worldGuid);
      await new Promise<void>((resolve) => {
        let failures = 0;
        scanTimer.current = setInterval(async () => {
          try {
            const status = await client.saveHealth(instanceId, worldGuid);
            failures = 0;
            if (status.phase === "idle") {
              if (scanTimer.current) clearInterval(scanTimer.current);
              if (status.error) setError(status.error);
              resolve();
            }
          } catch {
            // 掃描仍在 agent 上跑,單次查詢失敗不中斷;但連續失敗代表 agent 斷線,停止輪詢。
            failures += 1;
            if (failures >= 45) {
              if (scanTimer.current) clearInterval(scanTimer.current);
              setError(t("無法取得掃描狀態(與 agent 的連線中斷)。請重新整理後再試。"));
              resolve();
            }
          }
        }, 2000);
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  };

  const calculate = async () => {
    if (!breedingData || !targetId) return;
    cancelCalculation.current?.();
    const run = ++calculationRun.current;
    const entryId = nextHistoryId.current++;
    const requestTargetId = targetId;
    const requestDesired = [...passives];
    const requestOwnerUid = ownerUid;
    const requestMaxGenerations = maxGenerations;
    const upsertEntry = (solution: BreedingSolution) => {
      const entry: BreedingHistoryEntry = {
        id: entryId,
        targetId: requestTargetId,
        desired: requestDesired,
        ownerUid: requestOwnerUid,
        maxGenerations: requestMaxGenerations,
        solution,
      };
      setHistory((current) => {
        const exists = current.some((item) => item.id === entryId);
        return exists
          ? current.map((item) => item.id === entryId ? entry : item)
          : [entry, ...current].slice(0, 20);
      });
      setActiveHistoryId(entryId);
    };
    setCalculating(true);
    setError(null);
    const worker = new Worker(new URL("./breedingWorker.ts", import.meta.url), { type: "module" });
    try {
      const solution = await new Promise<BreedingSolution | null>((resolve, reject) => {
        let settled = false;
        let displayedRouteCount = 0;
        let latestRoutes: BreedingRoute[] = [];
        let finalSolution: BreedingSolution | null = null;
        let progressTimer: ReturnType<typeof setTimeout> | null = null;
        const cleanup = () => {
          if (progressTimer) clearTimeout(progressTimer);
          worker.terminate();
          if (cancelCalculation.current === cancel) cancelCalculation.current = null;
        };
        const finish = () => {
          if (!finalSolution || settled) return;
          settled = true;
          const result = finalSolution;
          cleanup();
          resolve(result);
        };
        const showNextRoute = () => {
          progressTimer = null;
          if (settled) return;
          if (displayedRouteCount < latestRoutes.length) {
            displayedRouteCount += 1;
            const routes = latestRoutes.slice(0, displayedRouteCount);
            if (calculationRun.current === run) {
              upsertEntry({
                target: routes[0]?.target ?? null,
                routes,
                reachableSpecies: finalSolution?.reachableSpecies ?? 0,
                requiredCaptures: routes[0]?.requiredCaptures ?? [],
              });
            }
          }
          if (displayedRouteCount < latestRoutes.length) {
            progressTimer = setTimeout(showNextRoute, 220);
          } else if (finalSolution) {
            finish();
          }
        };
        const queueRoutes = (routes: BreedingRoute[]) => {
          latestRoutes = routes;
          if (displayedRouteCount === 0) showNextRoute();
          else if (displayedRouteCount < latestRoutes.length && !progressTimer) {
            progressTimer = setTimeout(showNextRoute, 220);
          }
        };
        const cancel = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(null);
        };
        cancelCalculation.current = cancel;
        worker.onmessage = (event: MessageEvent<BreedingWorkerResponse>) => {
          if (settled) return;
          if (event.data.type === "progress") {
            queueRoutes(event.data.routes);
            return;
          }
          if (event.data.type === "complete") {
            finalSolution = event.data.solution;
            queueRoutes(finalSolution.routes);
            if (finalSolution.routes.length === 0 || displayedRouteCount >= finalSolution.routes.length) finish();
            return;
          }
          settled = true;
          cleanup();
          reject(new Error(event.data.error));
        };
        worker.onerror = (event) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(event.message || t("配種計算執行緒發生錯誤")));
        };
        worker.postMessage({
          data: breedingData,
          owned: available,
          targetId: requestTargetId,
          desiredPassives: requestDesired,
          maxGenerations: requestMaxGenerations,
        });
      });
      if (!solution || calculationRun.current !== run) return;
      upsertEntry(solution);
    } catch (err) {
      if (calculationRun.current === run) {
        setError(t("配種計算失敗:{error}", { error: err instanceof Error ? err.message : String(err) }));
      }
    } finally {
      if (calculationRun.current === run) setCalculating(false);
    }
  };

  const savePassivePreset = (ids: string[]) => {
    if (ids.length === 0) return;
    const key = passivePresetKey(ids);
    if (passivePresets.some((preset) => passivePresetKey(preset) === key)) return;
    const next = [...passivePresets, [...ids]];
    setPassivePresets(next);
    localStorage.setItem(PASSIVE_PRESETS_KEY, JSON.stringify(next));
  };

  const removePassivePreset = (index: number) => {
    const next = passivePresets.filter((_, current) => current !== index);
    setPassivePresets(next);
    localStorage.setItem(PASSIVE_PRESETS_KEY, JSON.stringify(next));
  };
  const activeEntry = history.find((entry) => entry.id === activeHistoryId) ?? null;

  if (entitled === false)
    return <SponsorLockNotice>{t("這是贊助者先行版功能。到「設定 → 贊助者識別碼」輸入識別碼即可使用。")}</SponsorLockNotice>;
  if (loading && !breedingData) return <p className="text-ink-muted">{t("載入中…")}</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-muted">
          {generatedAt
            ? t("存檔掃描於 {when} · 可用帕魯 {n} 隻", {
                when: new Date(generatedAt).toLocaleString(),
                n: available.length,
              })
            : t("尚未掃描存檔。先從存檔刷新以載入全服帕魯。")}
        </p>
        {canScan && (
          <button className={`${btnGhost} inline-flex items-center gap-1.5`} onClick={() => void scan()} disabled={scanning}>
            <FiRefreshCw className={`size-3.5 ${scanning ? "animate-spin" : ""}`} />
            {scanning ? t("掃描存檔中…(依存檔大小可能需要幾分鐘)") : t("從存檔刷新")}
          </button>
        )}
      </div>
      {error && <p className={errorCls}>{error}</p>}

      <div className="grid items-start gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className={`${card} lg:sticky lg:top-4`}>
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-extrabold text-ink">{t("配種歷史")}</h3>
              <p className="mt-0.5 text-xs text-ink-muted">{t("點擊記錄切換查詢結果")}</p>
            </div>
            {history.length > 0 && (
              <button type="button" className="text-xs font-bold text-ink-muted transition hover:text-berry" onClick={() => { setHistory([]); setActiveHistoryId(null); }}>
                {t("清除")}
              </button>
            )}
          </div>
          {history.length === 0 ? (
            <p className="mt-4 rounded-lg border-2 border-dashed border-line px-3 py-6 text-center text-xs text-ink-muted">{t("尚無配種記錄")}</p>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {history.map((entry) => {
                const entity = gameData?.palByIdLower.get(speciesId(entry.targetId).toLowerCase());
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className={`flex min-w-0 items-center gap-2 rounded-lg border-2 p-2.5 text-left transition ${activeHistoryId === entry.id ? "border-pal bg-pal/10" : "border-line bg-card-soft/40 hover:border-pal/50"}`}
                    onClick={() => {
                      invalidateDraft();
                      setTargetId(entry.targetId);
                      setPassives([...entry.desired]);
                      setOwnerUid(entry.ownerUid);
                      setMaxGenerations(entry.maxGenerations);
                      setActiveHistoryId(entry.id);
                    }}
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-card">
                      {entity?.icon && <img src={palIconUrl(entity.icon)} alt="" className="size-full object-contain" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-extrabold text-ink">{palName(gameData, entry.targetId)}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-ink-muted">
                        {entry.desired.length > 0 ? entry.desired.map((id) => gameData?.passiveById.get(id) ? displayName(gameData.passiveById.get(id)!) : id).join(" + ") : t("不限詞條")}
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] font-bold text-ink-muted">{entry.solution.routes.length}</span>
                  </button>
                );
              })}
            </div>
          )}
        </aside>

        <div className="flex min-w-0 flex-col gap-4">
          <div className={`${card} !p-0`}>
            <div className="border-b-2 border-line px-5 py-4">
              <h3 className="text-base font-extrabold text-ink">{t("新增配種查詢")}</h3>
              <p className="mt-1 text-xs text-ink-muted">{t("設定一隻目標帕魯，計算最多 5 條候選路線。")}</p>
            </div>
            <div className="grid gap-4 px-5 py-5 md:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <span className={labelCls}>{t("目標帕魯")}</span>
                <EntityPicker
                  catalog={gameData?.pals ?? []}
                  iconUrl={palIconUrl}
                  value={targetId}
                  onChange={(id) => { setTargetId(id); invalidateDraft(); }}
                  placeholder={t("搜尋目標帕魯…")}
                />
              </div>
              <label className="flex flex-col gap-1.5">
                <span className={labelCls}>{t("使用範圍")}</span>
                <Select value={ownerUid} onChange={(event) => { setOwnerUid(event.target.value); invalidateDraft(); }}>
                  <option value="">{t("全服玩家及公會據點的帕魯")}</option>
                  {owners.map(([uid, name]) => <option key={uid} value={uid}>{name}</option>)}
                </Select>
              </label>
              <div className="flex flex-col gap-2 md:col-span-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={labelCls}>{t("目標被動詞條(最多 4 個)")}</span>
                  <button
                    type="button"
                    className={`${btnGhost} inline-flex items-center gap-1.5 !px-2.5 !py-1.5`}
                    disabled={passives.length === 0 || passivePresets.some((preset) => passivePresetKey(preset) === passivePresetKey(passives))}
                    onClick={() => savePassivePreset(passives)}
                  >
                    <FiBookmark className="size-3.5" /> {t("儲存組合")}
                  </button>
                </div>
                <MultiPicker
                  catalog={gameData?.passives ?? []}
                  value={passives}
                  onChange={(ids) => { setPassives(ids); invalidateDraft(); }}
                  max={4}
                  closeOnSelect
                  ariaLabel={t("目標被動詞條(最多 4 個)")}
                  placeholder={t("搜尋被動詞條…")}
                />
                {passivePresets.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-bold text-ink-muted">{t("常用組合")}</span>
                    {passivePresets.map((preset, index) => (
                      <span key={passivePresetKey(preset)} className="inline-flex max-w-full items-center overflow-hidden rounded-full border-2 border-line bg-card-soft text-xs">
                        <button type="button" className="max-w-80 truncate py-1 pr-1 pl-2.5 font-bold text-ink transition hover:text-pal" onClick={() => { setPassives([...preset]); invalidateDraft(); }}>
                          {preset.map((id) => gameData?.passiveById.get(id) ? displayName(gameData.passiveById.get(id)!) : id).join(" + ")}
                        </button>
                        <button type="button" className="p-1.5 text-ink-muted transition hover:text-berry" onClick={() => removePassivePreset(index)} aria-label={t("刪除常用組合")} title={t("刪除常用組合")}>
                          <FiTrash2 className="size-3.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <label className="flex flex-col gap-1.5">
                <span className={labelCls}>{t("最大配種代數")}</span>
                <Select value={String(maxGenerations)} onChange={(event) => { setMaxGenerations(Number(event.target.value)); invalidateDraft(); }}>
                  {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{t("{n} 代", { n })}</option>)}
                </Select>
              </label>
              <div className="flex items-end">
                <button className={`${btn} inline-flex w-full items-center justify-center gap-1.5`} disabled={!targetId || !generatedAt || calculating} onClick={() => void calculate()}>
                  <FiSearch className="size-4" /> {calculating ? t("計算中…") : t("尋找多條配種路線")}
                </button>
              </div>
            </div>
          </div>

          {activeEntry && (
            <>
              <div>
                <h3 className="text-base font-extrabold text-ink">{palName(gameData, activeEntry.targetId)}</h3>
                <p className="mt-1 text-xs text-ink-muted">{t("找到 {n} 條候選路線", { n: activeEntry.solution.routes.length })}</p>
              </div>
              {activeEntry.solution.routes.length === 0 ? (
                <EmptyState icon={<GiEggClutch />} title={t("在 {n} 代內找不到路徑", { n: activeEntry.maxGenerations })}>
                  {t("已從現有帕魯推導出 {n} 個可達物種。可增加代數、擴大玩家範圍或減少目標詞條。", { n: activeEntry.solution.reachableSpecies })}
                </EmptyState>
              ) : (
                activeEntry.solution.routes.map((route, index) => (
                  <BreedingRoutePanel
                    key={`${activeEntry.id}-${index}`}
                    route={route}
                    index={index}
                    data={gameData}
                    desired={activeEntry.desired}
                    defaultOpen={index === 0}
                    onShowOnMap={onShowOnMap}
                  />
                ))
              )}
            </>
          )}

          {activeEntry && activeEntry.solution.routes.length > 0 && (
            <p className="text-center text-xs text-ink-muted">{t("路線圖顯示詞條的可能繼承路徑;實際遺傳有機率成分,通常需要重複配種幾次才能讓子代集齊全部目標詞條。")}</p>
          )}
        </div>
      </div>

      <p className="text-center text-[11px] text-ink-muted">
        {t("配方資料來自 Pal Calc {version}(MIT)", { version: breedingData?.version ?? "" })} ·{" "}
        <a className="underline" href="https://github.com/tylercamp/palcalc" target="_blank" rel="noreferrer">tylercamp/palcalc</a>
      </p>
    </div>
  );
}
