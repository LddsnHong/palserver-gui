import assert from "node:assert/strict";
import test from "node:test";
import type * as k8s from "@kubernetes/client-node";
import {
  computeCpuPercent,
  parseCpuAcctUsageMicros,
  parseCpuMaxCores,
  parseCpuQuotaCores,
  parseCpuStatUsageMicros,
  computeContainerUptimeSeconds,
  parseProcStatStartTicks,
  parseMemoryLimit,
  buildRolloutPatch,
  inspectK8sImageVersion,
  inspectK8sStartObservation,
  applyOptionalK8sConfigRestart,
  restartK8sContainer,
  rolloutRestart,
  retryWineSettingsSync,
  waitForK8sReady,
} from "./k8s.js";

function readyStatefulSet(replicas = 1): k8s.V1StatefulSet {
  return {
    metadata: { name: "wine-test", uid: "sts-1", generation: 2 },
    spec: {
      replicas,
      template: {
        spec: {
          containers: [{
            name: "palworld",
            image: "palserver/wine:test",
            volumeMounts: [{ name: "data", mountPath: "/palworld" }],
          }],
        },
      },
    },
    status: {
      observedGeneration: 2,
      readyReplicas: replicas,
      updatedReplicas: replicas,
      currentRevision: "wine-test-2",
      updateRevision: "wine-test-2",
    },
  } as k8s.V1StatefulSet;
}

function ownedPod(options: {
  uid?: string;
  restartCount?: number;
  ready?: boolean;
  waitingReason?: string;
  sidecarWaitingReason?: string;
  ownerUid?: string;
  terminating?: boolean;
} = {}): k8s.V1Pod {
  const ready = options.ready ?? true;
  return {
    metadata: {
      name: "wine-test-0",
      uid: options.uid ?? "pod-1",
      deletionTimestamp: options.terminating ? new Date() : undefined,
      labels: { workload: "custom-label" },
      ownerReferences: [{
        apiVersion: "apps/v1",
        kind: "StatefulSet",
        name: "wine-test",
        uid: options.ownerUid ?? "sts-1",
        controller: true,
      }],
    },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: ready ? "True" : "False" }],
      containerStatuses: [
        {
          name: "palworld",
          image: "palserver/wine:test",
          imageID: "sha256:game",
          ready,
          restartCount: options.restartCount ?? 0,
          state: options.waitingReason ? { waiting: { reason: options.waitingReason } } : { running: {} },
        },
        {
          name: "metrics",
          image: "metrics:latest",
          imageID: "sha256:metrics",
          ready: !options.sidecarWaitingReason,
          restartCount: 0,
          state: options.sidecarWaitingReason
            ? { waiting: { reason: options.sidecarWaitingReason } }
            : { running: {} },
        },
      ],
    },
  } as k8s.V1Pod;
}

test("parses cgroup v2 CPU and memory fields", () => {
  assert.equal(parseCpuStatUsageMicros("usage_usec 250000\nuser_usec 100"), 250000);
  assert.equal(parseCpuMaxCores("400000 100000", "processor : 0\nprocessor : 1"), 4);
  assert.equal(parseMemoryLimit("16777216"), 16777216);
  assert.equal(parseMemoryLimit("max"), 0);
});

test("rollout patch restarts without mutating the deployment image contract", () => {
  const patch = buildRolloutPatch("2026-07-29T00:00:00.000Z");
  assert.equal(patch.spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"], "2026-07-29T00:00:00.000Z");
  assert.equal("spec" in patch.spec.template, false);
});

test("image digest inspection targets the /palworld container when a sidecar is first", () => {
  const statefulSet = readyStatefulSet();
  statefulSet.spec!.template.spec!.containers = [
    { name: "metrics", image: "metrics:v1" },
    {
      name: "palworld",
      image: "palserver/wine:v2",
      volumeMounts: [{ name: "data", mountPath: "/palworld" }],
    },
  ];
  const pod = ownedPod();
  pod.status!.containerStatuses = [
    {
      name: "metrics",
      image: "metrics:v1",
      imageID: "docker.io/metrics@sha256:" + "a".repeat(64),
      ready: true,
      restartCount: 0,
    },
    {
      name: "palworld",
      image: "palserver/wine:v2",
      imageID: "docker.io/palserver/wine@sha256:" + "b".repeat(64),
      ready: true,
      restartCount: 0,
    },
  ];

  assert.deepEqual(inspectK8sImageVersion(statefulSet, pod), {
    image: "palserver/wine:v2",
    current: "sha256:" + "b".repeat(64),
  });
});

test("waits for the StatefulSet to become ready", async () => {
  const observations = [
    { status: "starting" as const },
    { status: "running" as const },
  ];
  await waitForK8sReady(async () => observations.shift() ?? { status: "running" }, {
    maxAttempts: 2,
    pollMs: 0,
  });
});

test("fails early when Kubernetes reports an image pull error", async () => {
  await assert.rejects(
    waitForK8sReady(
      async () => ({ status: "starting", failure: "ImagePullBackOff" }),
      { maxAttempts: 2, pollMs: 0 },
    ),
    /ImagePullBackOff/,
  );
});

test("fails when the StatefulSet never becomes ready", async () => {
  await assert.rejects(
    waitForK8sReady(
      async () => ({ status: "starting" }),
      { maxAttempts: 2, pollMs: 0 },
    ),
    /尚未 Ready/,
  );
});

test("reports a sidecar image pull failure from the actual StatefulSet-owned Pod", () => {
  const observation = inspectK8sStartObservation(
    readyStatefulSet(),
    [ownedPod({ ready: false, sidecarWaitingReason: "ImagePullBackOff" })],
    "wine-test",
  );
  assert.equal(observation.status, "starting");
  assert.equal(observation.failure, "ImagePullBackOff");
});

test("ignores terminating Pods and Pods owned by an older same-name StatefulSet", () => {
  const observation = inspectK8sStartObservation(
    readyStatefulSet(),
    [
      ownedPod({
        uid: "old-pod",
        ownerUid: "old-sts",
        ready: false,
        waitingReason: "ImagePullBackOff",
      }),
      ownedPod({
        uid: "terminating-pod",
        terminating: true,
        ready: false,
        waitingReason: "ErrImagePull",
      }),
      ownedPod({ uid: "current-pod", restartCount: 1 }),
    ],
    "wine-test",
  );
  assert.equal(observation.failure, undefined);
  assert.equal(observation.status, "running");
  assert.equal(observation.snapshot?.podUid, "current-pod");
});

test("does not accept stale Ready until the restarted game container advances", () => {
  const baseline = { podUid: "pod-1", containerName: "palworld", restartCount: 2 };
  const stale = inspectK8sStartObservation(
    readyStatefulSet(),
    [ownedPod({ uid: "pod-1", restartCount: 2 })],
    "wine-test",
    baseline,
  );
  assert.equal(stale.status, "starting");

  const restarted = inspectK8sStartObservation(
    readyStatefulSet(),
    [ownedPod({ uid: "pod-1", restartCount: 3 })],
    "wine-test",
    baseline,
  );
  assert.equal(restarted.status, "running");
});

test("does not hide a rejected StatefulSet rollout request", async () => {
  const baseline = { podUid: "pod-1", containerName: "palworld", restartCount: 2 };
  await assert.rejects(
    restartK8sContainer(
      async () => baseline,
      async () => {
        throw new Error("rollout patch rejected");
      },
    ),
    /rollout patch rejected/,
  );
});

test("only degrades a failed optional config write, not its accepted rollout", async () => {
  let restartCalls = 0;
  const skipped = await applyOptionalK8sConfigRestart(
    async () => {
      throw new Error("Engine.ini write failed");
    },
    async () => {
      restartCalls++;
      return { podUid: "pod-1", containerName: "palworld", restartCount: 0 };
    },
  );
  assert.equal(skipped, undefined);
  assert.equal(restartCalls, 0);

  await assert.rejects(
    applyOptionalK8sConfigRestart(
      async () => true,
      async () => {
        throw new Error("rollout rejected");
      },
    ),
    /rollout rejected/,
  );
});

test("bounds every StatefulSet rollout request at the shared entry point", async () => {
  await assert.rejects(
    rolloutRestart(
      {} as never,
      {
        patch: async () => {
          throw new Error("apiserver rejected rollout");
        },
      },
    ),
    /apiserver rejected rollout/,
  );

  await assert.rejects(
    rolloutRestart(
      {} as never,
      {
        timeoutMs: 10,
        patch: async () => new Promise(() => {}),
      },
    ),
    /rollout request timed out/,
  );
});

test("treats scale-to-zero during a start wait as cancellation", () => {
  const observation = inspectK8sStartObservation(
    readyStatefulSet(0),
    [],
    "wine-test",
  );
  assert.match(observation.failure ?? "", /取消/);
});

test("checks pull failures during Wine settings sync and preserves API errors", async () => {
  let syncAttempts = 0;
  await assert.rejects(
    retryWineSettingsSync(
      async () => {
        syncAttempts += 1;
        throw new Error("exec unavailable");
      },
      async () => ({ status: "starting", failure: "ImagePullBackOff" }),
      { maxAttempts: 30, pollMs: 0 },
    ),
    /ImagePullBackOff/,
  );
  assert.equal(syncAttempts, 1);

  await assert.rejects(
    retryWineSettingsSync(
      async () => {
        throw new Error("exec unavailable");
      },
      async () => {
        throw new Error("Kubernetes API unavailable");
      },
      { maxAttempts: 2, pollMs: 0 },
    ),
    /Kubernetes API unavailable/,
  );
});

test("spaces failed Wine settings attempts instead of exhausting retries in a hot loop", async () => {
  let attempts = 0;
  const startedAt = Date.now();
  await retryWineSettingsSync(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Pod not ready for exec");
    },
    async () => ({ status: "starting" }),
    { maxAttempts: 2, pollMs: 10, timeoutMs: 100 },
  );
  assert.equal(attempts, 2);
  assert.ok(Date.now() - startedAt >= 8);
});

test("observes cancellation while a Wine settings exec is still pending", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    retryWineSettingsSync(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
      },
      async () => ({
        status: "exited",
        failure: "啟動已取消：StatefulSet 已縮放為 0",
      }),
      { maxAttempts: 1, pollMs: 5, timeoutMs: 200 },
    ),
    /取消/,
  );
  assert.ok(Date.now() - startedAt < 60);
});

test("times out Wine settings sync even when the exec never settles in time", async () => {
  await assert.rejects(
    retryWineSettingsSync(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
      },
      async () => ({ status: "starting" }),
      { maxAttempts: 1, pollMs: 5, timeoutMs: 20 },
    ),
    /設定同步逾時/,
  );
});

test("enforces a wall-clock timeout even when an observation never resolves", async () => {
  await assert.rejects(
    waitForK8sReady(
      async () => new Promise(() => {}),
      { maxAttempts: 2, pollMs: 0, timeoutMs: 10 },
    ),
    /尚未 Ready/,
  );
});

test("parses cgroup v1 fallbacks", () => {
  assert.equal(parseCpuAcctUsageMicros("2000000\n"), 2000);
  assert.equal(parseCpuQuotaCores("200000", "100000", "processor : 0"), 2);
  assert.equal(parseCpuQuotaCores("-1", "100000", "processor : 0\nprocessor : 1"), 2);
  assert.equal(parseMemoryLimit("9223372036854771712"), 0);
});

test("computes CPU from two cumulative samples", () => {
  const previous = { podName: "palworld-0", usageMicros: 1_000_000, atMs: 1_000 };
  assert.equal(computeCpuPercent(previous, 1_500_000, 2_000), 50);
  assert.equal(computeCpuPercent(previous, 900_000, 2_000), null);
  assert.equal(computeCpuPercent(undefined, 1_500_000, 2_000), null);
});

test("computes container uptime from PID 1 start ticks", () => {
  const fields = Array.from({ length: 21 }, (_, index) => String(index + 1));
  fields[0] = "S";
  fields[19] = "900";
  assert.equal(parseProcStatStartTicks(`1 (test process) ${fields.join(" ")}`), 900);
  assert.equal(computeContainerUptimeSeconds(100, 900, 100), 91);
});
