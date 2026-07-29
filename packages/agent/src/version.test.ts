import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorldSettingsSchema } from "@palserver/shared";
import type { DriverContext } from "./driver.js";
import type { InstanceRecord } from "./store.js";
import { getVersionStatus, refreshImageVersionSummary } from "./version.js";

const rec: InstanceRecord = {
  id: "wine-test",
  name: "wine-test",
  backend: "k8s",
  flavor: "vanilla",
  runtime: "wine",
  gamePort: 8211,
  queryPort: 27015,
  k8sNamespace: "palserver-test",
  k8sStatefulSet: "palworld-game-server",
  k8sServiceName: "palworld-game-server",
  settings: WorldSettingsSchema.parse({
    RESTAPIEnabled: false,
    RCONEnabled: false,
  }),
  createdAt: "2026-07-29T00:00:00.000Z",
};

function tempContext(): DriverContext {
  return { instanceDir: fs.mkdtempSync(path.join(os.tmpdir(), "palserver-version-")) };
}

function writeImageCache(
  ctx: DriverContext,
  values: {
    current: string | null;
    latest: string | null;
    updateAvailable: boolean | null;
    checkedAt: string;
    runtimeRunning?: boolean;
  },
): void {
  fs.writeFileSync(path.join(ctx.instanceDir, "version.json"), JSON.stringify({
    imageCurrent: values.current,
    imageLatest: values.latest,
    imageUpdateAvailable: values.updateAvailable,
    imageCheckedAt: values.checkedAt,
    ...(values.runtimeRunning === undefined
      ? {}
      : { imageRuntimeRunning: values.runtimeRunning }),
  }));
}

test("runtime transition bypasses a fresh stopped image cache", async (t) => {
  const ctx = tempContext();
  t.after(() => fs.rmSync(ctx.instanceDir, { recursive: true, force: true }));
  writeImageCache(ctx, {
    current: null,
    latest: "sha256:latest",
    updateAvailable: null,
    checkedAt: new Date().toISOString(),
    runtimeRunning: false,
  });
  let reads = 0;

  await refreshImageVersionSummary(rec, ctx, {
    runtimeRunning: true,
    readDigests: async () => {
      reads += 1;
      return { current: "sha256:current", latest: "sha256:latest" };
    },
  });

  const cache = JSON.parse(fs.readFileSync(path.join(ctx.instanceDir, "version.json"), "utf8"));
  assert.equal(reads, 1);
  assert.equal(cache.imageCurrent, "sha256:current");
  assert.equal(cache.imageUpdateAvailable, true);
  assert.equal(cache.imageRuntimeRunning, true);
});

test("fresh image cache is reused while runtime state is unchanged", async (t) => {
  const ctx = tempContext();
  t.after(() => fs.rmSync(ctx.instanceDir, { recursive: true, force: true }));
  writeImageCache(ctx, {
    current: "sha256:same",
    latest: "sha256:same",
    updateAvailable: false,
    checkedAt: new Date().toISOString(),
    runtimeRunning: true,
  });
  let reads = 0;

  await refreshImageVersionSummary(rec, ctx, {
    runtimeRunning: true,
    readDigests: async () => {
      reads += 1;
      return { current: "sha256:new", latest: "sha256:new" };
    },
  });

  assert.equal(reads, 0);
});

test("legacy image cache without runtime state is refreshed on the next observation", async (t) => {
  const ctx = tempContext();
  t.after(() => fs.rmSync(ctx.instanceDir, { recursive: true, force: true }));
  writeImageCache(ctx, {
    current: null,
    latest: "sha256:latest",
    updateAvailable: null,
    checkedAt: new Date().toISOString(),
  });
  let reads = 0;

  await refreshImageVersionSummary(rec, ctx, {
    runtimeRunning: false,
    readDigests: async () => {
      reads += 1;
      return { current: null, latest: "sha256:latest" };
    },
  });

  assert.equal(reads, 1);
});

test("successful restart can force an image digest refresh", async (t) => {
  const ctx = tempContext();
  t.after(() => fs.rmSync(ctx.instanceDir, { recursive: true, force: true }));
  writeImageCache(ctx, {
    current: "sha256:old",
    latest: "sha256:new",
    updateAvailable: true,
    checkedAt: new Date().toISOString(),
    runtimeRunning: true,
  });
  let reads = 0;

  await refreshImageVersionSummary(rec, ctx, {
    runtimeRunning: true,
    force: true,
    readDigests: async () => {
      reads += 1;
      return { current: "sha256:new", latest: "sha256:new" };
    },
  });

  const cache = JSON.parse(fs.readFileSync(path.join(ctx.instanceDir, "version.json"), "utf8"));
  assert.equal(reads, 1);
  assert.equal(cache.imageUpdateAvailable, false);
});

test("serializes concurrent refreshes so an older failure cannot overwrite newer success", async (t) => {
  const ctx = tempContext();
  t.after(() => fs.rmSync(ctx.instanceDir, { recursive: true, force: true }));
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const slowFailure = refreshImageVersionSummary(rec, ctx, {
    runtimeRunning: true,
    force: true,
    timeoutMs: 1_000,
    readDigests: async () => {
      await slowGate;
      throw new Error("stale registry failure");
    },
  });
  const newerSuccess = refreshImageVersionSummary(rec, ctx, {
    runtimeRunning: true,
    force: true,
    timeoutMs: 1_000,
    readDigests: async () => ({
      current: "sha256:new",
      latest: "sha256:new",
    }),
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  releaseSlow();
  await Promise.all([slowFailure, newerSuccess]);

  const cache = JSON.parse(fs.readFileSync(path.join(ctx.instanceDir, "version.json"), "utf8"));
  assert.equal(cache.imageCurrent, "sha256:new");
  assert.equal(cache.imageUpdateAvailable, false);
});

test("bounds a pending digest reader and does not reject on cache write failure", async (t) => {
  const ctx = tempContext();
  t.after(() => fs.rmSync(ctx.instanceDir, { recursive: true, force: true }));
  const startedAt = Date.now();
  await refreshImageVersionSummary(rec, ctx, {
    runtimeRunning: true,
    force: true,
    timeoutMs: 15,
    readDigests: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { current: "sha256:late", latest: "sha256:late" };
    },
  });
  assert.ok(Date.now() - startedAt < 50);

  const blocker = path.join(ctx.instanceDir, "not-a-directory");
  fs.writeFileSync(blocker, "block");
  await assert.doesNotReject(
    refreshImageVersionSummary(rec, { instanceDir: path.join(blocker, "child") }, {
      runtimeRunning: true,
      force: true,
      readDigests: async () => ({ current: null, latest: null }),
    }),
  );
});

test("non-native version status reports the image check time", async (t) => {
  const ctx = tempContext();
  t.after(() => fs.rmSync(ctx.instanceDir, { recursive: true, force: true }));
  const imageCheckedAt = new Date(Date.now() - 60_000).toISOString();
  writeImageCache(ctx, {
    current: "sha256:same",
    latest: "sha256:same",
    updateAvailable: false,
    checkedAt: imageCheckedAt,
    runtimeRunning: false,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: {
      "2394010": {
        depots: {
          branches: { public: { buildid: "123", timeupdated: "1750000000" } },
          "2394011": { manifests: { public: { gid: "456" } } },
        },
      },
    },
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const status = await getVersionStatus(rec, ctx, false);
    assert.equal(status.checkedAt, imageCheckedAt);
    assert.equal(status.autoUpdate, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("version status echoes the restart-policy autoUpdate flag", async (t) => {
  const ctx = tempContext();
  t.after(() => fs.rmSync(ctx.instanceDir, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: {
      "2394010": {
        depots: {
          branches: { public: { buildid: "123", timeupdated: "1750000000" } },
          "2394011": { manifests: { public: { gid: "456" } } },
        },
      },
    },
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const enabled = await getVersionStatus(rec, ctx, true);
    assert.equal(enabled.autoUpdate, true);
    const disabled = await getVersionStatus(rec, ctx, false);
    assert.equal(disabled.autoUpdate, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
