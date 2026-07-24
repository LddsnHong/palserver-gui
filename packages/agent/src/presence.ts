import fs from "node:fs";
import path from "node:path";
import type { KnownPlayer, PresenceEvent } from "@palserver/shared";
import type { InstanceStore, InstanceRecord } from "./store.js";
import { rest } from "./restapi.js";
import { trackPlayers } from "./telemetry.js";
import { emitAgentEvent } from "./events.js";

/**
 * Tracks who is online by polling the game's REST API, and keeps a roster of
 * everyone ever seen on the instance. That roster is what lets the UI offer
 * offline players as targets (e.g. /unban) and show join/leave history.
 *
 * State lives next to the instance so it survives agent restarts. A session
 * that is open when the agent stops is closed on the next poll it misses —
 * playtime is only credited on an observed leave, so it under-counts rather
 * than inventing time.
 */

const POLL_MS = 15_000;
const MAX_EVENTS = 1000;

interface PresenceFile {
  known: Record<string, KnownPlayer>;
  events: PresenceEvent[];
  /** userId → ISO time the current session started (only for online players) */
  sessionStart: Record<string, string>;
}

const empty = (): PresenceFile => ({ known: {}, events: [], sessionStart: {} });

/**
 * 統一名冊排序:線上玩家在前,同群組內依 lastSeen 降序(最近上線在上、最久未上線在下)。
 * 無 agent 歷史(lastSeen === "")的玩家排最後 —— "".localeCompare(iso) < 0。
 */
export function compareKnownPlayers(a: KnownPlayer, b: KnownPlayer): number {
  return a.online === b.online ? b.lastSeen.localeCompare(a.lastSeen) : a.online ? -1 : 1;
}

export class PresenceTracker {
  private timer: NodeJS.Timeout | null = null;

  constructor(private store: InstanceStore) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private file(id: string): string {
    return path.join(this.store.instanceDir(id), "presence.json");
  }

  read(id: string): PresenceFile {
    try {
      return { ...empty(), ...JSON.parse(fs.readFileSync(this.file(id), "utf8")) };
    } catch {
      return empty();
    }
  }

  private write(id: string, data: PresenceFile): void {
    fs.mkdirSync(this.store.instanceDir(id), { recursive: true });
    fs.writeFileSync(this.file(id), JSON.stringify(data, null, 2));
  }

  knownPlayers(id: string): KnownPlayer[] {
    return Object.values(this.read(id).known).sort(compareKnownPlayers);
  }

  events(id: string, limit: number): PresenceEvent[] {
    return this.read(id).events.slice(-limit).reverse();
  }

  private async tick(): Promise<void> {
    for (const rec of this.store.list()) {
      try {
        await this.pollInstance(rec);
      } catch {
        // Server down, REST off, no admin password — nothing to record.
      }
    }
  }

  private async pollInstance(rec: InstanceRecord): Promise<void> {
    const players = await rest.players(rec); // throws when unreachable
    const now = new Date().toISOString();
    const data = this.read(rec.id);
    const onlineNow = new Set(players.map((p) => p.userId));
    const joined: string[] = [];

    for (const p of players) {
      const existing = data.known[p.userId];
      if (!existing || !existing.online) {
        data.events.push({ at: now, type: "join", userId: p.userId, name: p.name });
        data.sessionStart[p.userId] = now;
        joined.push(p.userId);
        emitAgentEvent("player.join", rec.id, {
          userId: p.userId,
          name: p.name,
          level: p.level,
          ping: p.ping,
        });
      }
      data.known[p.userId] = {
        userId: p.userId,
        name: p.name,
        accountName: p.accountName,
        online: true,
        firstSeen: existing?.firstSeen ?? now,
        lastSeen: now,
        sessions: existing?.sessions ?? 0,
        playtimeSeconds: existing?.playtimeSeconds ?? 0,
        lastLevel: p.level,
      };
    }

    for (const known of Object.values(data.known)) {
      if (!known.online || onlineNow.has(known.userId)) continue;
      const startedAt = data.sessionStart[known.userId];
      const seconds = startedAt
        ? Math.max(0, Math.round((Date.parse(known.lastSeen) - Date.parse(startedAt)) / 1000))
        : 0;
      data.known[known.userId] = {
        ...known,
        online: false,
        sessions: known.sessions + 1,
        playtimeSeconds: known.playtimeSeconds + seconds,
      };
      delete data.sessionStart[known.userId];
      data.events.push({ at: now, type: "leave", userId: known.userId, name: known.name });
      emitAgentEvent("player.leave", rec.id, { userId: known.userId, name: known.name });
    }

    if (data.events.length > MAX_EVENTS) data.events = data.events.slice(-MAX_EVENTS);
    this.write(rec.id, data);
    // 匿名玩家統計:只上報單向雜湊,用於全球不重複玩家計數(見 PRIVACY.md)。
    if (joined.length) trackPlayers(joined);
  }

  /** Mark everyone offline — used when an instance stops, so the roster
   * doesn't claim players are still connected. */
  markAllOffline(id: string): void {
    const data = this.read(id);
    let changed = false;
    const now = new Date().toISOString();
    for (const known of Object.values(data.known)) {
      if (!known.online) continue;
      changed = true;
      const startedAt = data.sessionStart[known.userId];
      const seconds = startedAt
        ? Math.max(0, Math.round((Date.parse(known.lastSeen) - Date.parse(startedAt)) / 1000))
        : 0;
      data.known[known.userId] = {
        ...known,
        online: false,
        sessions: known.sessions + 1,
        playtimeSeconds: known.playtimeSeconds + seconds,
      };
      delete data.sessionStart[known.userId];
      data.events.push({ at: now, type: "leave", userId: known.userId, name: known.name });
    }
    if (changed) this.write(id, data);
  }
}
