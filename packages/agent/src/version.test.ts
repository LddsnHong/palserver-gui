import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installedManifests } from "./version.js";

function makeDepotDownloaderDir(files: Array<{ name: string; mtimeMs: number }>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "palserver-version-test-"));
  const dir = path.join(root, ".DepotDownloader");
  fs.mkdirSync(dir);
  for (const { name, mtimeMs } of files) {
    fs.writeFileSync(path.join(dir, name), "");
    const time = mtimeMs / 1000;
    fs.utimesSync(path.join(dir, name), time, time);
  }
  return root;
}

test("installedManifests: picks the newest manifest by mtime, not readdir order", () => {
  // Same depot (2394011), three manifests left behind by successive updates.
  // Filenames are deliberately out of chronological order alphabetically:
  // the oldest id starts with "9", which sorts after ids starting with "4"/"5",
  // so a naive "last one wins while iterating readdirSync()" pick lands on
  // the stale manifest even though it was written first.
  const root = makeDepotDownloaderDir([
    { name: "2394011_959286178212427927.manifest", mtimeMs: Date.parse("2026-07-18T15:00:00Z") },
    { name: "2394011_5495152179854198969.manifest", mtimeMs: Date.parse("2026-07-30T01:27:00Z") },
    { name: "2394011_4660214116639624645.manifest", mtimeMs: Date.parse("2026-07-30T13:38:00Z") },
  ]);

  assert.deepEqual(installedManifests(root), { "2394011": "4660214116639624645" });
});

test("installedManifests: ignores non-manifest files and ok with an empty dir", () => {
  const root = makeDepotDownloaderDir([
    { name: "2394011_111.manifest", mtimeMs: Date.parse("2026-07-18T15:00:00Z") },
    { name: "2394011_111.manifest.sha", mtimeMs: Date.parse("2026-07-18T15:00:00Z") },
    { name: "depot.config", mtimeMs: Date.parse("2026-07-18T15:00:00Z") },
  ]);

  assert.deepEqual(installedManifests(root), { "2394011": "111" });
});

test("installedManifests: missing .DepotDownloader dir (adopted install) returns {}", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "palserver-version-test-"));
  assert.deepEqual(installedManifests(root), {});
});

test("installedManifests: tracks the newest manifest independently per depot", () => {
  const root = makeDepotDownloaderDir([
    { name: "1004_5612541580377302256.manifest", mtimeMs: Date.parse("2026-07-18T15:00:00Z") },
    { name: "2394011_959286178212427927.manifest", mtimeMs: Date.parse("2026-07-18T15:00:00Z") },
    { name: "2394011_4660214116639624645.manifest", mtimeMs: Date.parse("2026-07-30T13:38:00Z") },
  ]);

  assert.deepEqual(installedManifests(root), {
    "1004": "5612541580377302256",
    "2394011": "4660214116639624645",
  });
});
