import type { KnownPlayer, PdPlayerSummary } from "@palserver/shared";

interface PlayerIdentity {
  exact: string;
  platform?: string;
  numeric?: string;
}

const playerIdentity = (userId: string): PlayerIdentity => {
  const exact = userId.trim().toLowerCase();
  const prefixed = exact.match(/^([a-z][a-z0-9-]*)_(\d+)$/);
  if (prefixed) return { exact, platform: prefixed[1], numeric: prefixed[2] };
  return { exact, ...(exact.match(/^\d+$/) ? { numeric: exact } : {}) };
};

const nameKey = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();

const identitiesMatch = (left: PlayerIdentity, right: PlayerIdentity): boolean =>
  left.exact === right.exact ||
  Boolean(
    left.numeric &&
    left.numeric === right.numeric &&
    (!left.platform || !right.platform),
  );

function matchingIndices(
  players: KnownPlayer[],
  identity: PlayerIdentity,
  playerName: string,
): number[] {
  const exact = players
    .map((player, index) => ({ identity: playerIdentity(player.userId), index }))
    .filter((candidate) => candidate.identity.exact === identity.exact)
    .map((candidate) => candidate.index);
  if (exact.length) return exact;

  const compatible = players
    .map((player, index) => ({ player, identity: playerIdentity(player.userId), index }))
    .filter((candidate) => identitiesMatch(candidate.identity, identity));
  if (compatible.length <= 1) return compatible.map((candidate) => candidate.index);

  const name = nameKey(playerName);
  if (!name) return compatible.map((candidate) => candidate.index);
  const named = compatible.filter((candidate) => nameKey(candidate.player.name) === name);
  return named.length === 1
    ? named.map((candidate) => candidate.index)
    : compatible.map((candidate) => candidate.index);
}

function mergePlayer(player: PdPlayerSummary, previous?: KnownPlayer): KnownPlayer {
  return {
    userId: previous?.userId ?? player.userId.trim(),
    name: player.name.trim() || previous?.name || "",
    accountName: previous?.accountName ?? "",
    online: player.online,
    firstSeen: previous?.firstSeen ?? "",
    lastSeen: previous?.lastSeen ?? "",
    sessions: previous?.sessions ?? 0,
    playtimeSeconds: previous?.playtimeSeconds ?? 0,
    lastLevel: previous?.lastLevel ?? 0,
    ...(player.playerUid.trim() ? { playerUid: player.playerUid.trim() } : {}),
    ...(player.guildName.trim() ? { guildName: player.guildName.trim() } : {}),
  };
}

/**
 * Merge PalDefender's save-backed roster with the agent's presence history.
 *
 * Every PalDefender entry (online or offline) is shown at least once — dropping
 * one would make offline players vanish from the roster (the whole point of the
 * PalDefender 1.8+ save-backed list). Deduplication only happens when an entry
 * can be tied to exactly one agent-history record (an exact/compatible ID, or a
 * unique name for ID-less save entries); that record's history is then inherited
 * and consumed. Ambiguous matches keep the PalDefender entry on its own rather
 * than guessing. ID-less entries that match nothing are shown without a UserId
 * (visible in the roster, just not targetable by kick/ban).
 */
export function mergeKnownPlayers(
  ownPlayers: KnownPlayer[],
  pdPlayers: PdPlayerSummary[],
): KnownPlayer[] {
  const remaining = [...ownPlayers];
  const merged: KnownPlayer[] = [];
  const missingId = pdPlayers.filter((player) => !playerIdentity(player.userId).exact);

  for (const player of pdPlayers) {
    const identity = playerIdentity(player.userId);
    if (!identity.exact || matchingIndices(merged, identity, player.name).length) continue;
    const previousMatches = matchingIndices(remaining, identity, player.name);
    // Inherit an agent record only when the match is unambiguous. A bare numeric
    // ID can match multiple platforms — don't guess which; keep the PalDefender
    // entry on its own id instead, but still show it (dropping = the player
    // disappears from the roster).
    const previous = previousMatches.length === 1
      ? remaining.splice(previousMatches[0], 1)[0]
      : undefined;
    merged.push(mergePlayer(player, previous));
  }

  const pdNameCounts = new Map<string, number>();
  for (const player of missingId) {
    const name = nameKey(player.name);
    if (name) pdNameCounts.set(name, (pdNameCounts.get(name) ?? 0) + 1);
  }

  for (const player of missingId) {
    const name = nameKey(player.name);
    // Inherit an agent record's id/history only when a unique name pins down a
    // single agent record; otherwise show the entry with no UserId (visible,
    // just not targetable). Never drop it — that is what hid offline players.
    let previous: KnownPlayer | undefined;
    if (name && pdNameCounts.get(name) === 1) {
      const matches = remaining
        .map((candidate, index) => ({ candidate, index }))
        .filter(({ candidate }) => nameKey(candidate.name) === name);
      if (matches.length === 1) {
        const { candidate, index } = matches[0];
        const identity = playerIdentity(candidate.userId);
        if (identity.exact && !matchingIndices(merged, identity, candidate.name).length) {
          previous = remaining.splice(index, 1)[0];
        }
      }
    }
    merged.push(mergePlayer(player, previous));
  }

  const seenExactIds = new Set(
    merged.map((player) => playerIdentity(player.userId).exact).filter(Boolean),
  );
  for (const player of remaining) {
    const id = playerIdentity(player.userId).exact;
    if (id && seenExactIds.has(id)) continue;
    merged.push(player);
    if (id) seenExactIds.add(id);
  }
  return merged;
}
