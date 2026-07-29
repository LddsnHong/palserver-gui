import assert from "node:assert/strict";
import test from "node:test";
import { imageDigest, parseImageReference, registryImageDigest } from "./image-digest.js";

test("parses Docker Hub namespace images without adding library", () => {
  assert.deepEqual(parseImageReference("palserver/vanilla:latest"), {
    registry: "registry-1.docker.io",
    repository: "palserver/vanilla",
    reference: "latest",
  });
  assert.deepEqual(parseImageReference("ubuntu:latest"), {
    registry: "registry-1.docker.io",
    repository: "library/ubuntu",
    reference: "latest",
  });
});

test("preserves explicit registry and digest references", () => {
  assert.deepEqual(parseImageReference("ghcr.io/acme/palserver:v2"), {
    registry: "ghcr.io",
    repository: "acme/palserver",
    reference: "v2",
  });
  assert.deepEqual(parseImageReference("palserver/vanilla@sha256:abc"), {
    registry: "registry-1.docker.io",
    repository: "palserver/vanilla",
    reference: "sha256:abc",
  });
  assert.equal(imageDigest("docker.io/palserver/vanilla@sha256:" + "a".repeat(64)), "sha256:" + "a".repeat(64));
});

test("registry lookup uses the correct namespace path", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input) => {
    urls.push(String(input));
    return new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:" + "b".repeat(64) } });
  }) as typeof fetch;
  try {
    assert.equal(await registryImageDigest("palserver/vanilla:latest"), "sha256:" + "b".repeat(64));
    assert.deepEqual(urls, ["https://registry-1.docker.io/v2/palserver/vanilla/manifests/latest"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
