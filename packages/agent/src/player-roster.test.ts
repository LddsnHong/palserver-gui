import assert from "node:assert/strict";
import test from "node:test";
import type { KnownPlayer, PdPlayerSummary } from "@palserver/shared";
import { mergeKnownPlayers } from "./player-roster.js";

const known = (patch: Partial<KnownPlayer> & Pick<KnownPlayer, "userId" | "name">): KnownPlayer => ({
  accountName: "",
  online: false,
  firstSeen: "2026-07-01T00:00:00.000Z",
  lastSeen: "2026-07-20T00:00:00.000Z",
  sessions: 3,
  playtimeSeconds: 3600,
  lastLevel: 10,
  ...patch,
});

const pd = (patch: Partial<PdPlayerSummary> & Pick<PdPlayerSummary, "userId" | "name">): PdPlayerSummary => ({
  playerUid: "",
  guildName: "",
  online: false,
  ip: "",
  ...patch,
});

test("mergeKnownPlayers merges PalDefender entries with missing UserId by unique name", () => {
  const result = mergeKnownPlayers(
    [
      known({ userId: "steam_76561198000000001", name: "Alice", lastLevel: 42 }),
      known({ userId: "steam_76561198000000002", name: "Bob", lastLevel: 21 }),
    ],
    [
      pd({ userId: "", name: "Alice", guildName: "Builders" }),
      pd({ userId: "", name: "Bob", guildName: "Explorers" }),
    ],
  );

  assert.equal(result.length, 2);
  assert.deepEqual(result.map((player) => player.userId), [
    "steam_76561198000000001",
    "steam_76561198000000002",
  ]);
  assert.deepEqual(result.map((player) => player.guildName), ["Builders", "Explorers"]);
  assert.deepEqual(result.map((player) => player.lastLevel), [42, 21]);
});

test("mergeKnownPlayers matches Steam IDs with and without the steam_ prefix", () => {
  const result = mergeKnownPlayers(
    [known({ userId: "steam_76561198000000001", name: "Old name", sessions: 8 })],
    [pd({ userId: "76561198000000001", name: "Current name", online: true })],
  );

  assert.equal(result.length, 1);
  assert.equal(result[0]?.userId, "steam_76561198000000001");
  assert.equal(result[0]?.name, "Current name");
  assert.equal(result[0]?.online, true);
  assert.equal(result[0]?.sessions, 8);
});

test("mergeKnownPlayers matches GDK and PS5 IDs with and without platform prefixes", () => {
  const result = mergeKnownPlayers(
    [
      known({ userId: "gdk_2533274963232060", name: "Xbox player", sessions: 5 }),
      known({ userId: "ps5_4877707100835767776", name: "PlayStation player", sessions: 7 }),
    ],
    [
      pd({ userId: "2533274963232060", name: "Xbox player", online: true }),
      pd({ userId: "4877707100835767776", name: "PlayStation player", online: false }),
    ],
  );

  assert.equal(result.length, 2);
  assert.deepEqual(result.map((player) => player.userId), [
    "gdk_2533274963232060",
    "ps5_4877707100835767776",
  ]);
  assert.deepEqual(result.map((player) => player.sessions), [5, 7]);
});

test("mergeKnownPlayers keeps an ambiguous bare-numeric entry on its own id (still shown)", () => {
  const result = mergeKnownPlayers(
    [
      known({ userId: "gdk_1234567890123456", name: "Xbox player" }),
      known({ userId: "ps5_1234567890123456", name: "PlayStation player" }),
    ],
    [pd({ userId: "1234567890123456", name: "Unknown platform" })],
  );

  // 裸數字對到兩個平台 → 不猜繼承哪個,但仍以自身 id 顯示(不丟棄,否則離線玩家會消失)。
  assert.equal(result.length, 3);
  assert.deepEqual(result.map((player) => player.userId).sort(), [
    "1234567890123456",
    "gdk_1234567890123456",
    "ps5_1234567890123456",
  ]);
});

test("mergeKnownPlayers shows ID-less PalDefender-only entries (visible, not targetable)", () => {
  const result = mergeKnownPlayers(
    [known({ userId: "steam_76561198000000001", name: "Alice" })],
    [pd({ userId: "", name: "Unknown" })],
  );

  // 無 id、對不到 own 的離線玩家仍要顯示(舊版行為),只是不可 kick/ban。
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((player) => player.name).sort(), ["Alice", "Unknown"]);
  assert.equal(result.find((player) => player.name === "Unknown")?.userId, "");
});

test("mergeKnownPlayers does not guess an owner for an ambiguous name but still shows the entry", () => {
  const result = mergeKnownPlayers(
    [
      known({ userId: "steam_76561198000000001", name: "Same name" }),
      known({ userId: "steam_76561198000000002", name: "Same name" }),
    ],
    [pd({ userId: "", name: "Same name", guildName: "Guild" })],
  );

  // own 有兩個同名 → 不亂繼承任一個(兩筆 own 的 guildName 保持 undefined),
  // 但 PalDefender 那筆仍以自身無 id 形式顯示(帶自己的 Guild)。
  assert.equal(result.length, 3);
  assert.equal(result.filter((player) => player.userId === "" && player.guildName === "Guild").length, 1);
  assert.equal(result.filter((player) => player.userId !== "" && player.guildName === undefined).length, 2);
});

test("mergeKnownPlayers shows offline PalDefender players the agent never recorded", () => {
  // Bug 回歸守門(#60):agent 沒在線看過的離線玩家(own 空),PalDefender 存檔有一批,
  // 不管 UserId 是 steam_ / 裸數字 / 空,都必須顯示,不能消失。
  const result = mergeKnownPlayers(
    [],
    [
      pd({ userId: "steam_76561198000000009", name: "Offline A" }),
      pd({ userId: "1234567890", name: "Offline B" }),
      pd({ userId: "", name: "Offline C" }),
    ],
  );

  assert.equal(result.length, 3);
  assert.deepEqual(result.map((player) => player.name).sort(), ["Offline A", "Offline B", "Offline C"]);
});
