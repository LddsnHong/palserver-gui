import * as k8s from "@kubernetes/client-node";
import { INSTANCE_LABEL } from "./env.js";
import { docker } from "./docker.js";
import { findPodName, loadKubeConfig, ownedPodsForStatefulSet } from "./k8s-files.js";
import { tcpPortFree, udpPortFree, type PortCheckEntry } from "./port-check.js";
import type { InstanceRecord } from "./store.js";

const DOCKER_HOST_PORTS = new Set<PortCheckEntry["key"]>(["game", "query", "rest"]);

/** Check a port in the network namespace that will actually own it. */
export async function runtimePortFree(
  rec: InstanceRecord,
  entry: { key: PortCheckEntry["key"]; port: number; protocol: "udp" | "tcp" },
): Promise<boolean> {
  if (rec.backend === "native") {
    return entry.protocol === "udp" ? udpPortFree(entry.port) : tcpPortFree(entry.port);
  }

  if (rec.backend === "docker") {
    // The Docker driver publishes only game/query/REST to the host. RCON and
    // PalDefender stay inside the isolated container network namespace; their
    // same-instance collision is handled by checkPorts' duplicate check.
    if (!DOCKER_HOST_PORTS.has(entry.key)) return true;
    if (await dockerHostPortInUse(rec.id, entry.port, entry.protocol)) return false;
    return entry.protocol === "udp" ? udpPortFree(entry.port) : tcpPortFree(entry.port);
  }

  // A ClusterIP Service can reuse numeric ports across namespaces. Conflicts
  // that matter for k8s are NodePorts and hostNetwork listeners; managed
  // instance records are checked separately by checkPorts.
  return !(await k8sHostPortInUse(rec, entry.port, entry.protocol));
}

async function dockerHostPortInUse(excludeInstanceId: string, port: number, protocol: "udp" | "tcp"): Promise<boolean> {
  try {
    const containers = await docker.listContainers({ all: true });
    for (const item of containers) {
      if (item.Labels?.[INSTANCE_LABEL] === excludeInstanceId) continue;
      const info = await docker.getContainer(item.Id).inspect().catch(() => null);
      const bindings = info?.HostConfig?.PortBindings as
        | Record<string, { HostPort?: string }[] | null | undefined>
        | undefined;
      for (const [containerPort, values] of Object.entries(bindings ?? {})) {
        if (!containerPort.endsWith(`/${protocol}`)) continue;
        if ((values ?? []).some((binding) => Number(binding.HostPort) === port)) return true;
      }
    }
  } catch {
    // If Docker is unavailable, the normal host probe below still provides a
    // useful answer and the subsequent start operation reports Docker errors.
  }
  return false;
}

async function k8sHostPortInUse(rec: InstanceRecord, port: number, protocol: "udp" | "tcp"): Promise<boolean> {
  if (!rec.k8sNamespace || !rec.k8sStatefulSet) return false;
  try {
    const kc = loadKubeConfig();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    // NodePort is cluster-wide. A service's ordinary ClusterIP port is not.
    const services = await coreApi.listServiceForAllNamespaces();
    const nodePortConflict = services.items.some((service) => {
      if (
        service.metadata?.namespace === rec.k8sNamespace &&
        service.metadata?.name === rec.k8sServiceName
      ) {
        return false;
      }
      return (service.spec?.ports ?? []).some(
        (servicePort) =>
          servicePort.nodePort === port &&
          (servicePort.protocol ?? "TCP").toLowerCase() === protocol,
      );
    });
    if (nodePortConflict) return true;

    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const statefulSet = await appsApi.readNamespacedStatefulSet({
      name: rec.k8sStatefulSet,
      namespace: rec.k8sNamespace,
    });
    const templateSpec = statefulSet.spec?.template?.spec;
    if (!templateSpec?.hostNetwork) return false;

    // hostNetwork binds on a node, not in the ClusterIP namespace. When the
    // target is stopped there may be no node assignment, so conservatively
    // inspect all running hostNetwork Pods for a listener declaration.
    const targetPodName = await findPodName(
      coreApi,
      rec.k8sNamespace,
      rec.k8sStatefulSet,
      statefulSet.metadata?.uid,
    ).catch(() => null);
    const targetPod = targetPodName
      ? await coreApi.readNamespacedPod({ name: targetPodName, namespace: rec.k8sNamespace }).catch(() => null)
      : null;
    const nodeName = targetPod?.spec?.nodeName;
    const pods = nodeName
      ? await coreApi.listPodForAllNamespaces({ fieldSelector: `spec.nodeName=${nodeName}` })
      : await coreApi.listPodForAllNamespaces();
    return pods.items.some((pod) => {
      if (pod.status?.phase !== "Running" || pod.metadata?.deletionTimestamp) return false;
      if (
        pod.metadata?.namespace === rec.k8sNamespace &&
        ownedPodsForStatefulSet(
          [pod],
          rec.k8sStatefulSet!,
          statefulSet.metadata?.uid,
        ).length > 0
      ) {
        return false;
      }
      if (!pod.spec?.hostNetwork) return false;
      return (pod.spec.containers ?? []).some((container) =>
        (container.ports ?? []).some(
          (containerPort) =>
            containerPort.containerPort === port &&
            (containerPort.protocol ?? "TCP").toLowerCase() === protocol,
        ),
      );
    });
  } catch {
    // A missing/insufficient kube API permission must not make the start gate
    // unusable; managed-store conflicts are still deterministic.
    return false;
  }
}
