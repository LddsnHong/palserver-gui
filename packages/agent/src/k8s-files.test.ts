import assert from "node:assert/strict";
import test from "node:test";
import type * as k8s from "@kubernetes/client-node";
import {
  ownedPodsForStatefulSet,
  resolvePodPath,
  selectStatefulSetContainerName,
} from "./k8s-files.js";

test("resolves safe Pod-relative paths", () => {
  assert.equal(resolvePodPath("Pal/Saved/Config/LinuxServer/Engine.ini"), "/palworld/Pal/Saved/Config/LinuxServer/Engine.ini");
  assert.equal(resolvePodPath("./Pal//Saved"), "/palworld/Pal/Saved");
});

test("rejects Pod path traversal and shell-escape inputs", () => {
  for (const value of ["/etc/passwd", "../secret", "Pal/../secret", "Pal\\Saved"]) {
    assert.throws(() => resolvePodPath(value), /路徑不合法/);
  }
  // A quote is safe because it is passed as an argv value, never interpolated
  // into shell source.
  assert.equal(resolvePodPath("Pal/' && touch /tmp/pwned"), "/palworld/Pal/' && touch /tmp/pwned");
});

test("finds StatefulSet Pods by owner reference instead of an assumed app label", () => {
  const pods = [
    {
      metadata: {
        name: "wine-test-0",
        labels: { workload: "custom-label" },
        ownerReferences: [{ apiVersion: "apps/v1", kind: "StatefulSet", name: "wine-test", uid: "sts-1", controller: true }],
      },
    },
    {
      metadata: {
        name: "old-wine-test-0",
        labels: { app: "wine-test" },
        deletionTimestamp: new Date(),
        ownerReferences: [{ apiVersion: "apps/v1", kind: "StatefulSet", name: "wine-test", uid: "old-sts", controller: true }],
      },
    },
  ] as k8s.V1Pod[];

  assert.deepEqual(
    ownedPodsForStatefulSet(pods, "wine-test", "sts-1").map((pod) => pod.metadata?.name),
    ["wine-test-0"],
  );
});

test("selects the game container by its /palworld mount when a sidecar is first", () => {
  const statefulSet = {
    spec: {
      template: {
        spec: {
          containers: [
            { name: "metrics", image: "metrics:latest" },
            {
              name: "palworld",
              image: "palserver/wine:test",
              volumeMounts: [{ name: "data", mountPath: "/palworld" }],
            },
          ],
        },
      },
    },
  } as k8s.V1StatefulSet;

  assert.equal(selectStatefulSetContainerName(statefulSet), "palworld");
});
