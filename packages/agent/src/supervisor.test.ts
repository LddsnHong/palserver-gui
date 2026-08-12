import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DEFAULT_RESTART_POLICY, type RestartPolicy } from "@palserver/shared";
import {
  RestartSupervisor,
  dailyFireKey,
  type ImageVersionRefresher,
  type UpdateAvailabilityReader,
  type UpdateRestartAction,
} from "./supervisor.js";
import { newestPalDefenderLogLines } from "./native.js";
import { compareImageDigests } from "./version.js";
import type { ServerDriver } from "./driver.js";
import type { InstanceRecord, InstanceStore } from "./store.js";

/** 回歸測試:排程重啟必須等舊程序真的退出才啟動新程序。
 *  情境還原自 2026-07-16 線上事故:REST /shutdown 要求 10 秒後關機,舊碼只睡 5 秒
 *  就呼叫 driver.start(),start() 看到舊程序還活著就靜默 no-op —— 重啟根本沒發生,
 *  幾秒後舊程序自行退出又被誤判成「PalDefender 啟動失敗」,自動重啟就此停擺。 */
test("scheduled restart waits for the old process to exit before starting", { timeout: 60_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "palsup-"));
  seedState(tmp); // check() 進 restart 前必已落檔 wasRunning=true,測試比照

  // 假的遊戲 REST API:save/announce/shutdown 一律 200;收到 shutdown 時
  // 模擬「舊程序 8 秒後才真正退出」(8s > 舊碼盲睡的 5s,< 新碼 60s poll 上限)。
  const order: string[] = [];
  let exitAt: number | null = null;
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/save")) order.push("save");
    if (req.url?.endsWith("/shutdown")) order.push("shutdown");
    if (req.url?.endsWith("/shutdown")) exitAt = Date.now() + 8_000;
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const rec = {
    id: "t1",
    backend: "native",
    settings: { RESTAPIEnabled: true, RESTAPIPort: port, AdminPassword: "pw" },
  } as unknown as InstanceRecord;

  const oldAlive = () => exitAt === null || Date.now() < exitAt;
  let spawnedAt: number | null = null; // 新程序 spawn 的時刻
  let noopStarts = 0; // 舊程序還活著時就被叫 start 的次數(修復前會是 1)
  let forceStops = 0;
  const driver: ServerDriver = {
    status: async () => ({
      status: spawnedAt !== null ? "running" : oldAlive() ? "running" : "exited",
      runtimeId: null,
    }),
    start: async () => {
      order.push("start");
      if (spawnedAt === null && oldAlive()) {
        noopStarts++; // 比照 native driver:看到活程序就 no-op
        return false;
      }
      spawnedAt = Date.now();
      return true;
    },
    stop: async () => {
      forceStops++;
      exitAt = Date.now();
    },
    remove: async () => {},
    stats: async () => null,
    streamLogs: async () => () => {},
    logSources: () => [],
  };

  const store = { list: () => [rec], instanceDir: () => tmp } as unknown as InstanceStore;
  const prepared: string[] = [];
  const supervisor = new RestartSupervisor(store, () => driver);
  supervisor.setUpdateRestartPreparation(async (value) => {
    prepared.push(value.id);
    return value;
  });
  const policy = { ...DEFAULT_RESTART_POLICY, announceSeconds: 0 };
  const state = { wasRunning: true, memoryStreak: 0, recentRestarts: [], events: [] };
  supervisor.writePolicy(rec.id, policy);

  const t0 = Date.now();
  await supervisor.restartForUpdate(rec, "測試更新", async () => {
    order.push("update");
  });
  server.close();

  assert.equal(noopStarts, 0, "start() 不得在舊程序還活著時被呼叫(修復前此值為 1)");
  assert.ok(spawnedAt !== null, "新程序必須真的被 spawn");
  assert.ok(exitAt !== null && spawnedAt >= exitAt, "spawn 必須發生在舊程序退出之後");
  assert.equal(forceStops, 0, "8 秒內自行退出,不應觸發強制停止");
  assert.deepEqual(prepared, [rec.id], "更新重啟啟動前必須執行更新專用 side-effect");
  assert.deepEqual(order, ["save", "shutdown", "update", "start"], "更新必須在安全停止後才下載並啟動");
  const last = readEvents(tmp).at(-1);
  assert.ok(last?.ok, "重啟事件必須記錄為成功");
  assert.equal(last?.reason, "update", "重啟事件必須標記為 update");
  // 全程約 5s(存檔等待) + 8s(等舊程序退出),遠短於 poll 上限
  assert.ok(Date.now() - t0 < 45_000);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 落一份「伺服器正在跑」的初始狀態檔 —— 生產環境中 check() 進 restart()
 *  前一定已寫入 wasRunning=true,少了它會被「手動停止守門」正確地取消。 */
function seedState(dir: string): void {
  fs.writeFileSync(
    path.join(dir, "restart-state.json"),
    JSON.stringify({ wasRunning: true, memoryStreak: 0, recentRestarts: [], events: [] }),
  );
}

/** 事件寫在 instanceDir 的 restart-state.json(restart() 以 fresh read 寫回)。 */
function readEvents(dir: string): { ok: boolean; detail: string; reason?: string }[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "restart-state.json"), "utf8")) as {
      events?: { ok: boolean; detail: string; reason?: string }[];
    };
    return raw.events ?? [];
  } catch {
    return [];
  }
}

/** 共用腳手架:假 REST + 假 driver,收到 /shutdown 時呼叫 onShutdown。 */
async function rig(opts: {
  onShutdown: (api: RigApi) => void;
  onUpdate?: UpdateRestartAction;
  updateAvailable?: boolean;
  onImageRefresh?: ImageVersionRefresher;
}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "palsup-"));
  seedState(tmp);
  let exitAt: number | null = null;
  let runtimeId = "old-pid";
  let spawns = 0;
  const api: RigApi = {
    tmp,
    killOld: () => { exitAt = Date.now(); },
    takeover: () => { exitAt = null; runtimeId = "new-pid"; },
    spawns: () => spawns,
  };
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/shutdown")) {
      exitAt = Date.now() + 30_000; // 預設拖很久,由 onShutdown 決定劇情
      setTimeout(() => opts.onShutdown(api), 2_000);
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const rec = {
    id: "t-rig",
    backend: "native",
    settings: { RESTAPIEnabled: true, RESTAPIPort: port, AdminPassword: "pw" },
  } as unknown as InstanceRecord;
  const oldAlive = () => exitAt === null || Date.now() < exitAt;
  const driver: ServerDriver = {
    status: async () => ({
      status: runtimeId !== "old-pid" || oldAlive() ? "running" : "exited",
      runtimeId: runtimeId !== "old-pid" ? runtimeId : oldAlive() ? "old-pid" : null,
    }),
    start: async () => { spawns++; return true; },
    stop: async () => { exitAt = Date.now(); },
    remove: async () => {},
    stats: async () => null,
    streamLogs: async () => () => {},
    logSources: () => [],
  };
  const store = { list: () => [rec], instanceDir: () => tmp } as unknown as InstanceStore;
  const readUpdateSummary: UpdateAvailabilityReader | undefined = opts.updateAvailable === undefined
    ? undefined
    : () => ({ gameVersion: null, updateAvailable: opts.updateAvailable! });
  const supervisor = new RestartSupervisor(
    store,
    () => driver,
    opts.onUpdate,
    readUpdateSummary,
    opts.onImageRefresh,
  );
  return { tmp, rec, driver, supervisor, server, spawns: () => spawns };
}
interface RigApi { tmp: string; killOld: () => void; takeover: () => void; spawns: () => number }

test("post-start image refresh is best-effort", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "palrefresh-"));
  const rec = { id: "refresh-safe", backend: "k8s", settings: {} } as unknown as InstanceRecord;
  const store = { list: () => [rec], instanceDir: () => tmp } as unknown as InstanceStore;
  const supervisor = new RestartSupervisor(
    store,
    () => ({} as ServerDriver),
    undefined,
    undefined,
    async () => {
      throw new Error("version cache disk failure");
    },
  );

  await assert.doesNotReject(
    supervisor.noteRuntimeStarted(rec, { instanceDir: tmp }),
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("restart downloads a detected native update before starting", { timeout: 60_000 }, async () => {
  let updateCalls = 0;
  let imageRefreshes = 0;
  const rigged = await rig({
    onShutdown: (api) => api.killOld(),
    updateAvailable: true,
    onUpdate: async (_rec, _ctx) => {
      updateCalls++;
      assert.equal(rigged.spawns(), 0, "新版下載完成前不得啟動伺服器");
    },
    onImageRefresh: async (_rec, _ctx, options) => {
      imageRefreshes++;
      assert.ok(options);
      assert.equal(options.runtimeRunning, true);
      assert.equal(options.force, true);
    },
  });
  const { tmp, rec, driver, supervisor, server, spawns } = rigged;
  await supervisor.restart(rec, { instanceDir: tmp }, driver, { ...DEFAULT_RESTART_POLICY, announceSeconds: 0 },
    { wasRunning: true, memoryStreak: 0, recentRestarts: [], events: [] } as Parameters<RestartSupervisor["restart"]>[4],
    "scheduled", "測試排程");
  server.close();
  assert.equal(updateCalls, 1, "偵測到新版時重啟前必須下載一次");
  assert.equal(spawns(), 1, "下載完成後才啟動伺服器");
  assert.equal(imageRefreshes, 1, "成功啟動後必須強制刷新 image digest");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("update gate applies to every backend before a start", async () => {
  const backends = ["native", "docker", "k8s"] as const;
  for (const backend of backends) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "palgate-"));
    const rec = { id: `gate-${backend}`, backend, settings: {} } as unknown as InstanceRecord;
    const store = { list: () => [rec], instanceDir: () => tmp } as unknown as InstanceStore;
    let updates = 0;
    const supervisor = new RestartSupervisor(
      store,
      () => ({} as ServerDriver),
      async () => { updates++; },
      () => ({ gameVersion: null, updateAvailable: true }),
    );

    await supervisor.applyUpdateBeforeStart(rec, { instanceDir: tmp });
    assert.equal(updates, 1, `${backend} 必須在啟動前套用偵測到的更新`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("manual restart uses the supervisor update gate", { timeout: 60_000 }, async () => {
  let updateCalls = 0;
  const rigged = await rig({
    onShutdown: (api) => api.killOld(),
    updateAvailable: true,
    onUpdate: async () => { updateCalls++; },
  });
  const { tmp, rec, supervisor, server, spawns } = rigged;
  await supervisor.restartForManual(rec, "測試手動重啟", { announceSeconds: 0 });
  server.close();
  assert.equal(updateCalls, 1, "手動重啟必須在 start 前套用更新");
  assert.equal(spawns(), 1, "手動重啟必須仍走 supervisor 安全啟動");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("start gate cancels after a manual stop during update", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "palstart-stop-"));
  const rec = { id: "start-stop", backend: "native", settings: {} } as unknown as InstanceRecord;
  const store = { list: () => [rec], instanceDir: () => tmp } as unknown as InstanceStore;
  const supervisor = new RestartSupervisor(
    store,
    () => ({} as ServerDriver),
    async () => {
      fs.writeFileSync(
        path.join(tmp, "restart-state.json"),
        JSON.stringify({ wasRunning: false, memoryStreak: 0, recentRestarts: [], events: [] }),
      );
    },
    () => ({ gameVersion: null, updateAvailable: true }),
  );

  const canStart = await supervisor.applyUpdateBeforeStart(
    rec,
    { instanceDir: tmp },
    { markRunning: true, respectManualStop: true },
  );
  assert.equal(canStart, false, "更新期間的手動停止必須取消後續 start");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("update restart skips start after a manual stop during update", { timeout: 60_000 }, async () => {
  const rigged = await rig({
    onShutdown: (api) => api.killOld(),
    updateAvailable: true,
    onUpdate: async () => {
      const raw = JSON.parse(fs.readFileSync(path.join(rigged.tmp, "restart-state.json"), "utf8"));
      fs.writeFileSync(path.join(rigged.tmp, "restart-state.json"), JSON.stringify({ ...raw, wasRunning: false }));
    },
  });
  const { tmp, rec, supervisor, server, spawns } = rigged;
  await supervisor.restartForUpdate(rec, "測試停止中的更新");
  server.close();
  assert.equal(spawns(), 0, "更新期間手動停止後不得 start");
  assert.match(readEvents(tmp).at(-1)?.detail ?? "", /更新準備期間/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("auto update fires once on false-to-true and is throttled afterwards", { timeout: 60_000 }, async () => {
  let updateCalls = 0;
  const options = {
    onShutdown: (api: RigApi) => api.killOld(),
    updateAvailable: false,
    onUpdate: async () => { updateCalls++; },
  };
  const rigged = await rig(options);
  const { tmp, rec, supervisor, server } = rigged;
  const policy = { ...DEFAULT_RESTART_POLICY, autoUpdate: true, announceSeconds: 0 };
  supervisor.writePolicy(rec.id, policy);
  const emit = (supervisor as unknown as {
    emitUpdateTransition: (
      rec: InstanceRecord,
      ctx: { instanceDir: string },
      policy: RestartPolicy,
      status: "running",
    ) => Promise<void>;
  }).emitUpdateTransition.bind(supervisor);

  await emit(rec, { instanceDir: tmp }, policy, "running"); // establish false baseline
  options.updateAvailable = true;
  await emit(rec, { instanceDir: tmp }, policy, "running"); // trigger once
  await emit(rec, { instanceDir: tmp }, policy, "running"); // true -> true: no second restart

  server.close();
  assert.equal(updateCalls, 1, "新版只應觸發一次自動更新");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("image digest comparison returns update, current, or unknown", () => {
  assert.equal(compareImageDigests("sha256:old", "sha256:new"), true);
  assert.equal(compareImageDigests("sha256:same", "sha256:same"), false);
  assert.equal(compareImageDigests(null, "sha256:new"), null);
});

/** 等待期間伺服器被手動重啟接手(runtimeId 變了)→ 取消排程重啟,不碰新程序。 */
test("scheduled restart hands over when a manual restart takes over mid-wait", { timeout: 60_000 }, async () => {
  const { tmp, rec, driver, supervisor, server, spawns } = await rig({
    onShutdown: (api) => api.takeover(), // 模擬手動重啟:新 pid 接管
  });
  const state = { wasRunning: true, memoryStreak: 0, recentRestarts: [], events: [] };
  await supervisor.restart(rec, { instanceDir: tmp }, driver, { ...DEFAULT_RESTART_POLICY, announceSeconds: 0 },
    state as Parameters<RestartSupervisor["restart"]>[4], "scheduled", "測試");
  server.close();
  assert.equal(spawns(), 0, "接手後不得再 spawn(會疊在使用者的新程序上)");
  const events = readEvents(tmp);
  assert.match(events.at(-1)?.detail ?? "", /接手/, "必須記錄「已被手動重啟接手」事件");
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 等待期間使用者手動停止(wasRunning=false 落檔 + 程序被停掉)→ 尊重停止,不自動復活。 */
test("scheduled restart respects a manual stop mid-wait", { timeout: 60_000 }, async () => {
  const { tmp, rec, driver, supervisor, server, spawns } = await rig({
    onShutdown: (api) => {
      // 模擬 /stop 路由:殺程序 + noteManualState(false) 落檔
      api.killOld();
      const f = path.join(api.tmp, "restart-state.json");
      const cur = (() => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } })();
      fs.writeFileSync(f, JSON.stringify({ ...cur, wasRunning: false, memoryStreak: 0, recentRestarts: cur.recentRestarts ?? [], events: cur.events ?? [] }));
    },
  });
  const state = { wasRunning: true, memoryStreak: 0, recentRestarts: [], events: [] };
  await supervisor.restart(rec, { instanceDir: tmp }, driver, { ...DEFAULT_RESTART_POLICY, announceSeconds: 0 },
    state as Parameters<RestartSupervisor["restart"]>[4], "scheduled", "測試");
  server.close();
  assert.equal(spawns(), 0, "手動停止後不得自動復活(driver.start 不得被呼叫)");
  const events = readEvents(tmp);
  assert.match(events.at(-1)?.detail ?? "", /手動停止/, "必須記錄「偵測到手動停止」事件");
  const finalState = JSON.parse(fs.readFileSync(path.join(tmp, "restart-state.json"), "utf8")) as { wasRunning: boolean };
  assert.equal(finalState.wasRunning, false, "伺服器必須維持停止");
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** daily 模式「公告先行、準點重啟」:觸發鍵以 now+announceSeconds 對表,
 *  使用者設 00:00 且公告 300 秒,23:55 就要開跑;跨日以目標日為鍵。 */
test("dailyFireKey leads by announceSeconds and lands on the configured time", () => {
  const p = (times: string[], announce: number) => ({ announceSeconds: announce, scheduled: { dailyTimes: times } });
  // 公告 300 秒:23:55 觸發、目標 00:00(跨日,鍵用隔天日期)
  const nov1_2355 = new Date(2026, 10, 1, 23, 55, 10);
  const key = dailyFireKey(p(["00:00"], 300), nov1_2355);
  assert.ok(key !== null, "23:55 就必須觸發(300 秒後正是 00:00)");
  assert.ok(key!.startsWith(new Date(2026, 10, 2).toDateString()), "跨日觸發的鍵必須掛在目標日(11/2)");
  // 同一分鐘內第二個 tick:鍵相同(由 lastDailyFire 防重複觸發)
  assert.equal(key, dailyFireKey(p(["00:00"], 300), new Date(2026, 10, 1, 23, 55, 40)));
  // 沒到時間就不觸發
  assert.equal(dailyFireKey(p(["00:00"], 300), new Date(2026, 10, 1, 23, 54, 0)), null);
  assert.equal(dailyFireKey(p(["00:00"], 300), new Date(2026, 10, 1, 23, 56, 0)), null);
  // 公告 0 秒:準點觸發
  assert.ok(dailyFireKey(p(["06:00"], 0), new Date(2026, 10, 1, 6, 0, 5)) !== null);
  // 多時刻:每個都能觸發
  const four = ["00:00", "06:00", "12:00", "18:00"];
  assert.ok(dailyFireKey(p(four, 0), new Date(2026, 10, 1, 12, 0, 0)) !== null);
  assert.ok(dailyFireKey(p(four, 0), new Date(2026, 10, 1, 18, 0, 29)) !== null);
  assert.equal(dailyFireKey(p(four, 0), new Date(2026, 10, 1, 3, 0, 0)), null);
});

/** 「最後日誌」提示只能引用本次啟動之後寫入的 PalDefender 日誌 ——
 *  上一輪程序的收尾訊息(如「REST API stopped」)會誤導診斷。 */
test("newestPalDefenderLogLines respects sinceMs", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "palpd-"));
  const logs = path.join(tmp, "server", "Pal", "Binaries", "Win64", "PalDefender", "logs");
  fs.mkdirSync(logs, { recursive: true });

  const oldFile = path.join(logs, "old.log");
  const newFile = path.join(logs, "new.log");
  fs.writeFileSync(oldFile, "[01:49:13][info] REST API stopped\n");
  fs.writeFileSync(newFile, "[07:54:40][error] failed to bind pdapi\n");
  const now = Date.now();
  fs.utimesSync(oldFile, new Date(now - 60_000), new Date(now - 60_000));
  fs.utimesSync(newFile, new Date(now), new Date(now));

  const rec = {} as InstanceRecord;
  const ctx = { instanceDir: tmp };
  // 無過濾:拿到最新檔
  assert.match(newestPalDefenderLogLines(rec, ctx, 1)[0] ?? "", /failed to bind/);
  // 以「兩檔之間」為界:舊檔被排除,仍拿到新檔
  assert.match(newestPalDefenderLogLines(rec, ctx, 1, now - 30_000)[0] ?? "", /failed to bind/);
  // 以「兩檔之後」為界:本次啟動期間沒有日誌 → 空,不得回傳舊檔尾巴
  assert.deepEqual(newestPalDefenderLogLines(rec, ctx, 1, now + 30_000), []);
  fs.rmSync(tmp, { recursive: true, force: true });
});
