import assert from "node:assert/strict";
import test from "node:test";
import type { KnownPlayer } from "@palserver/shared";
import { compareKnownPlayers } from "./presence.js";

const p = (patch: Partial<KnownPlayer> & Pick<KnownPlayer, "userId" | "name">): KnownPlayer => ({
  accountName: "",
  online: false,
  firstSeen: "",
  lastSeen: "",
  sessions: 0,
  playtimeSeconds: 0,
  lastLevel: 0,
  ...patch,
});

test("compareKnownPlayers: online players sort before offline", () => {
  const online = p({ userId: "a", name: "A", online: true, lastSeen: "2026-07-20" });
  const offline = p({ userId: "b", name: "B", online: false, lastSeen: "2026-07-24" });
  assert.ok(compareKnownPlayers(online, offline) < 0, "online should sort before offline");
  assert.ok(compareKnownPlayers(offline, online) > 0, "offline should sort after online");
});

test("compareKnownPlayers: offline group by lastSeen descending (most-recently-seen first)", () => {
  const recent = p({ userId: "a", name: "A", lastSeen: "2026-07-24T10:00:00.000Z" });
  const older = p({ userId: "b", name: "B", lastSeen: "2026-07-20T00:00:00.000Z" });
  assert.ok(compareKnownPlayers(recent, older) < 0, "recently-seen should sort above older");
});

test("compareKnownPlayers: empty lastSeen (no agent history) sorts last — longest absent", () => {
  const has = p({ userId: "a", name: "A", lastSeen: "2026-07-20" });
  const empty = p({ userId: "b", name: "B", lastSeen: "" });
  assert.ok(compareKnownPlayers(has, empty) < 0, "empty lastSeen sorts last");
});

test("compareKnownPlayers: full roster order online → recent → older → empty", () => {
  const players = [
    p({ userId: "old", name: "Old", lastSeen: "2026-07-20T00:00:00.000Z" }),
    p({ userId: "on", name: "On", online: true, lastSeen: "2026-07-19" }),
    p({ userId: "none", name: "None", lastSeen: "" }),
    p({ userId: "new", name: "New", lastSeen: "2026-07-24T10:00:00.000Z" }),
  ];
  const sorted = [...players].sort(compareKnownPlayers).map((x) => x.userId);
  assert.deepEqual(sorted, ["on", "new", "old", "none"]);
});
