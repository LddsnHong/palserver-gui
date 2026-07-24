import assert from "node:assert/strict";
import test from "node:test";
import { resolveFixedTagDownload } from "./mods.js";

test("resolves the fixed UE4SS asset without using the GitHub API", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    assert.equal(init?.method, "HEAD");
    return new Response(null, {
      status: 200,
      headers: { "last-modified": "Sun, 19 Jul 2026 07:14:13 GMT" },
    });
  };

  try {
    const result = await resolveFixedTagDownload("ue4ss", "stable");
    assert.deepEqual(result, {
      version: "experimental-palworld (2026-07-19)",
      url: "https://github.com/Okaetsu/RE-UE4SS/releases/download/experimental-palworld/UE4SS-Palworld.zip",
    });
    assert.equal(calls.some((url) => url.includes("api.github.com")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("beta channel downloads zDev but versions from the stable asset (no false update badge)", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    assert.equal(init?.method, "HEAD");
    return new Response(null, {
      status: 200,
      headers: { "last-modified": "Sun, 19 Jul 2026 07:14:13 GMT" },
    });
  };

  try {
    const result = await resolveFixedTagDownload("ue4ss", "beta");
    // 版本以「標準版」資產日期為準,與更新徽章(latestModVersions 永遠查 stable)同源 → 不會誤報「有新版」。
    assert.equal(result?.version, "experimental-palworld (2026-07-19)");
    // 下載連結仍指向 zDev 開發版資產。
    assert.equal(
      result?.url,
      "https://github.com/Okaetsu/RE-UE4SS/releases/download/experimental-palworld/UE4SS-Palworld_zDev.zip",
    );
    // 版本日期是 HEAD「標準版」資產拿到的,不是 zDev。
    assert.ok(calls.some((u) => u.includes("/UE4SS-Palworld.zip")));
    assert.equal(
      calls.some((url) => url.includes("api.github.com")),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
