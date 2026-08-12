import fs from "node:fs";
import path from "node:path";
import type { VersionStatus } from "@palserver/shared";
import { DATA_DIR } from "./env.js";
import type { DriverContext } from "./driver.js";
import type { InstanceRecord } from "./store.js";
import { serverRoot } from "./native.js";
import { rest } from "./restapi.js";
import { rconExec } from "./rcon.js";
import { imageVersionDigests as dockerImageVersionDigests } from "./docker.js";
import { imageVersionDigests as k8sImageVersionDigests } from "./k8s.js";

/**
 * Version reporting for native instances.
 *
 * "Installed" comes from the manifest ids DepotDownloader leaves behind in
 * `.DepotDownloader/<depotId>_<manifestId>.manifest` — readable whether or
 * not the server is running. "Latest" comes from the public branch on Steam
 * (via api.steamcmd.net, which needs no key). Comparing manifest ids per
 * depot is exact: a mismatch means the depot's content changed.
 *
 * The friendly game version ("v0.7.2") only exists in the server's own REST
 * /info, so it is cached per instance whenever the server is reachable.
 */

const APP_ID = "2394010";
const STEAM_INFO_URL = `https://api.steamcmd.net/v1/info/${APP_ID}`;
const LATEST_TTL_MS = 30 * 60_000;
const LATEST_CACHE = path.join(DATA_DIR, `steam-app-${APP_ID}.json`);

/** Depots that ship the Steamworks redistributable, not game content. */
const SDK_DEPOTS = new Set(["1004", "1005", "1006", "228989"]);

interface LatestInfo {
  buildId: string;
  updatedAt: string | null;
  /** depotId → manifest id on the public branch */
  manifests: Record<string, string>;
  fetchedAt: string;
}

let latestMemo: LatestInfo | null = null;

function readLatestCache(): LatestInfo | null {
  try {
    return JSON.parse(fs.readFileSync(LATEST_CACHE, "utf8"));
  } catch {
    return null;
  }
}

/** Latest public-branch info, memoized for 30 min and cached on disk so an
 * offline agent still shows the last known state instead of nothing. */
export async function fetchLatest(force = false): Promise<LatestInfo | null> {
  const cached = latestMemo ?? readLatestCache();
  if (!force && cached && Date.now() - Date.parse(cached.fetchedAt) < LATEST_TTL_MS) {
    latestMemo = cached;
    return cached;
  }
  try {
    const res = await fetch(STEAM_INFO_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      data: Record<
        string,
        {
          depots: Record<string, unknown> & {
            branches?: { public?: { buildid?: string; timeupdated?: string } };
          };
        }
      >;
    };
    const app = body.data[APP_ID];
    const branch = app.depots.branches?.public;
    const manifests: Record<string, string> = {};
    for (const [depotId, depot] of Object.entries(app.depots)) {
      if (!/^\d+$/.test(depotId) || typeof depot !== "object" || depot === null) continue;
      const pub = (depot as { manifests?: { public?: { gid?: string } | string } }).manifests?.public;
      const gid = typeof pub === "string" ? pub : pub?.gid;
      if (gid) manifests[depotId] = gid;
    }
    const info: LatestInfo = {
      buildId: branch?.buildid ?? "",
      updatedAt: branch?.timeupdated
        ? new Date(Number(branch.timeupdated) * 1000).toISOString()
        : null,
      manifests,
      fetchedAt: new Date().toISOString(),
    };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LATEST_CACHE, JSON.stringify(info, null, 2));
    latestMemo = info;
    return info;
  } catch {
    return cached; // stale is better than blank
  }
}

/**
 * depotId → manifest id, as installed on disk.
 *
 * DepotDownloader never deletes a depot's old `<depotId>_<manifestId>.manifest`
 * file when it patches to a new one — it just adds another one alongside it,
 * so a depot that's been updated a few times ends up with several manifest
 * files. `fs.readdirSync` order is not guaranteed to be chronological (in
 * practice it comes back roughly alphabetical), so naively taking "whichever
 * one we saw last per depotId" can and does land on a stale manifest — e.g.
 * an old id starting with "9" sorts after a current one starting with "4",
 * even though the "4" one is what's actually installed. That made
 * `updateAvailable` report true forever, even right after a successful
 * update. Picking the file with the newest mtime instead reflects what
 * DepotDownloader most recently wrote, which is what's actually installed.
 */
export function installedManifests(root: string): Record<string, string> {
  const dir = path.join(root, ".DepotDownloader");
  const result: Record<string, string> = {};
  const mtimes: Record<string, number> = {};
  try {
    for (const name of fs.readdirSync(dir)) {
      const match = /^(\d+)_(\d+)\.manifest$/.exec(name);
      if (!match) continue;
      const [, depotId, manifestId] = match;
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(path.join(dir, name)).mtimeMs;
      } catch {
        continue;
      }
      if (!(depotId in result) || mtimeMs > mtimes[depotId]) {
        result[depotId] = manifestId;
        mtimes[depotId] = mtimeMs;
      }
    }
  } catch {
    /* not an agent-managed install (e.g. adopted from Steam) */
  }
  return result;
}

const versionCacheFile = (ctx: DriverContext) => path.join(ctx.instanceDir, "version.json");
const IMAGE_CACHE_TTL_MS = 6 * 60 * 60_000;
const IMAGE_UNKNOWN_CACHE_TTL_MS = 60_000;
const IMAGE_REFRESH_TIMEOUT_MS = 20_000;
const imageRefreshQueues = new Map<string, Promise<void>>();

interface ImageVersionSummary {
  current: string | null;
  latest: string | null;
  updateAvailable: boolean | null;
  checkedAt: string;
  runtimeRunning: boolean | null;
}

export interface ImageVersionRefreshOptions {
  runtimeRunning?: boolean;
  force?: boolean;
  readDigests?: () => Promise<{ current: string | null; latest: string | null }>;
  now?: () => Date;
  timeoutMs?: number;
}

function readVersionCache(ctx: DriverContext): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(versionCacheFile(ctx), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readImageVersionSummary(ctx: DriverContext): ImageVersionSummary | null {
  const raw = readVersionCache(ctx);
  if (
    typeof raw.imageCurrent !== "string" && raw.imageCurrent !== null ||
    typeof raw.imageLatest !== "string" && raw.imageLatest !== null ||
    typeof raw.imageUpdateAvailable !== "boolean" && raw.imageUpdateAvailable !== null ||
    typeof raw.imageCheckedAt !== "string"
  ) return null;
  return {
    current: raw.imageCurrent as string | null,
    latest: raw.imageLatest as string | null,
    updateAvailable: raw.imageUpdateAvailable as boolean | null,
    checkedAt: raw.imageCheckedAt as string,
    runtimeRunning: typeof raw.imageRuntimeRunning === "boolean"
      ? raw.imageRuntimeRunning
      : null,
  };
}

function writeImageVersionSummary(ctx: DriverContext, summary: ImageVersionSummary): void {
  fs.mkdirSync(ctx.instanceDir, { recursive: true });
  fs.writeFileSync(versionCacheFile(ctx), JSON.stringify({
    ...readVersionCache(ctx),
    imageCurrent: summary.current,
    imageLatest: summary.latest,
    imageUpdateAvailable: summary.updateAvailable,
    imageCheckedAt: summary.checkedAt,
    imageRuntimeRunning: summary.runtimeRunning,
  }, null, 2));
}

export function compareImageDigests(current: string | null, latest: string | null): boolean | null {
  if (!current || !latest) return null;
  return current !== latest;
}

async function withImageRefreshTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("image digest refresh timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Refresh docker/k8s image state at a deliberately low cadence. Registry
 * failures are represented as unknown and never block the server loop. */
async function refreshImageVersionSummaryUnlocked(
  rec: InstanceRecord,
  ctx: DriverContext,
  options: ImageVersionRefreshOptions = {},
): Promise<void> {
  if (rec.backend === "native") return;
  const existing = readImageVersionSummary(ctx);
  const runtimeChanged =
    options.runtimeRunning !== undefined &&
    existing?.runtimeRunning !== options.runtimeRunning;
  const cacheTtlMs = existing?.current && existing.latest
    ? IMAGE_CACHE_TTL_MS
    : IMAGE_UNKNOWN_CACHE_TTL_MS;
  if (
    !options.force &&
    !runtimeChanged &&
    existing &&
    Date.now() - Date.parse(existing.checkedAt) < cacheTtlMs
  ) return;
  let digests: { current: string | null; latest: string | null };
  try {
    const readDigests = options.readDigests
      ? options.readDigests()
      : rec.backend === "docker"
        ? dockerImageVersionDigests(rec)
        : k8sImageVersionDigests(rec);
    digests = await withImageRefreshTimeout(
      readDigests,
      Math.max(1, options.timeoutMs ?? IMAGE_REFRESH_TIMEOUT_MS),
    );
  } catch {
    digests = { current: null, latest: null };
  }
  try {
    writeImageVersionSummary(ctx, {
      ...digests,
      updateAvailable: compareImageDigests(digests.current, digests.latest),
      checkedAt: (options.now?.() ?? new Date()).toISOString(),
      runtimeRunning: options.runtimeRunning ?? existing?.runtimeRunning ?? null,
    });
  } catch {
    // Version evidence is best-effort and must never undo a successful start.
  }
}

export async function refreshImageVersionSummary(
  rec: InstanceRecord,
  ctx: DriverContext,
  options: ImageVersionRefreshOptions = {},
): Promise<void> {
  const key = versionCacheFile(ctx);
  const previous = imageRefreshQueues.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => refreshImageVersionSummaryUnlocked(rec, ctx, options));
  imageRefreshQueues.set(key, current);
  try {
    await current;
  } finally {
    if (imageRefreshQueues.get(key) === current) imageRefreshQueues.delete(key);
  }
}

function readGameVersion(ctx: DriverContext): string | null {
  const value = readVersionCache(ctx).gameVersion;
  return typeof value === "string" ? value : null;
}

function writeGameVersion(ctx: DriverContext, gameVersion: string): void {
  fs.mkdirSync(ctx.instanceDir, { recursive: true });
  fs.writeFileSync(versionCacheFile(ctx), JSON.stringify({ ...readVersionCache(ctx), gameVersion }, null, 2));
}

/** Compare content depots only; SDK depots move on their own schedule. */
function compare(
  installed: Record<string, string>,
  latest: Record<string, string>,
): { updateAvailable: boolean | null; installedBuild: string | null } {
  const contentDepots = Object.keys(installed).filter((d) => !SDK_DEPOTS.has(d));
  if (contentDepots.length === 0) return { updateAvailable: null, installedBuild: null };

  const comparable = contentDepots.filter((d) => latest[d]);
  const installedBuild = installed[contentDepots[0]] ?? null;
  if (comparable.length === 0) return { updateAvailable: null, installedBuild };

  return {
    updateAvailable: comparable.some((d) => installed[d] !== latest[d]),
    installedBuild,
  };
}

/**
 * The game's own version string ("v0.7.2"). The REST API reports it directly;
 * RCON's `Info` embeds it in "Welcome to Pal Server[v0.7.2]", which covers
 * servers that expose RCON but not REST.
 */
async function liveGameVersion(rec: InstanceRecord): Promise<string | null> {
  const info = await rest.info(rec).catch(() => null);
  if (info?.version) return info.version;

  const output = await rconExec(rec, "Info").catch(() => null);
  return output?.match(/\[(v[\d.]+)\]/)?.[1] ?? null;
}

/** Cheap, no network: used when listing instances. */
export function cachedVersionSummary(
  rec: InstanceRecord,
  ctx: DriverContext,
): { gameVersion: string | null; updateAvailable: boolean | null } {
  // native (Windows or Linux): DepotDownloader manifest comparison works on
  // any OS — the manifest files live under serverRoot/.DepotDownloader.
  // docker/k8s: version comes from REST API only (manifest is inside container).
  if (rec.backend !== "native") {
    return { gameVersion: readGameVersion(ctx), updateAvailable: readImageVersionSummary(ctx)?.updateAvailable ?? null };
  }
  const latest = latestMemo ?? readLatestCache();
  const installed = installedManifests(serverRoot(rec, ctx));
  return {
    gameVersion: readGameVersion(ctx),
    updateAvailable: latest ? compare(installed, latest.manifests).updateAvailable : null,
  };
}

export async function getVersionStatus(
  rec: InstanceRecord,
  ctx: DriverContext,
  autoUpdate: boolean,
): Promise<VersionStatus> {
  // Refresh the friendly version whenever the server is up; otherwise reuse
  // whatever we last saw.
  let gameVersion = readGameVersion(ctx);
  const live = await liveGameVersion(rec);
  if (live) {
    gameVersion = live;
    writeGameVersion(ctx, gameVersion);
  }

  if (rec.backend !== "native") {
    // docker/k8s: compare the runtime image digest with the registry digest;
    // REST version strings and Steam build IDs are intentionally not mixed.
    await refreshImageVersionSummary(rec, ctx);
    const imageSummary = readImageVersionSummary(ctx);
    const latest = await fetchLatest();
    return {
      supported: true,
      reason: live ? undefined : "伺服器未運行中，無法取得版本",
      gameVersion,
      installedBuild: imageSummary?.current ?? null,
      latestBuild: imageSummary?.latest ?? null,
      latestUpdatedAt: latest?.updatedAt ?? null,
      updateAvailable: imageSummary?.updateAvailable ?? null,
      checkedAt: imageSummary?.checkedAt ?? null,
      autoUpdate,
    };
  }

  // native (Windows or Linux): exact manifest comparison via DepotDownloader.
  const latest = await fetchLatest();
  const installed = installedManifests(serverRoot(rec, ctx));
  const { updateAvailable, installedBuild } = latest
    ? compare(installed, latest.manifests)
    : { updateAvailable: null, installedBuild: installedManifests(serverRoot(rec, ctx))["2394011"] ?? null };

  return {
    supported: true,
    reason:
      installedBuild === null
        ? "找不到安裝資訊(收編的伺服器可能由 Steam 管理),無法比對版本"
        : undefined,
    gameVersion,
    installedBuild,
    latestBuild: latest?.manifests["2394011"] ?? latest?.buildId ?? null,
    latestUpdatedAt: latest?.updatedAt ?? null,
    updateAvailable,
    checkedAt: latest?.fetchedAt ?? null,
    autoUpdate,
  };
}
