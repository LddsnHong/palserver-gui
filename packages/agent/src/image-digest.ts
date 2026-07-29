import crypto from "node:crypto";

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

interface ImageReference {
  registry: string;
  repository: string;
  reference: string;
}

export function parseImageReference(image: string): ImageReference | null {
  const trimmed = image.trim();
  if (!trimmed) return null;
  const parts = trimmed.split("/");
  const hasRegistry = parts.length > 1 && (parts[0].includes(".") || parts[0].includes(":") || parts[0] === "localhost");
  const registry = hasRegistry ? parts.shift()! : "registry-1.docker.io";
  let repository = parts.join("/");
  // Docker Hub's `library` namespace is only implicit for official images
  // written as a single component (`ubuntu`). A namespaced image such as
  // `palserver/vanilla` already contains its repository path.
  if (!hasRegistry && parts.length === 1) repository = `library/${repository}`;
  let reference = "latest";
  const at = repository.lastIndexOf("@");
  if (at > 0) {
    reference = repository.slice(at + 1);
    repository = repository.slice(0, at);
  } else {
    const slash = repository.lastIndexOf("/");
    const colon = repository.lastIndexOf(":");
    if (colon > slash) {
      reference = repository.slice(colon + 1);
      repository = repository.slice(0, colon);
    }
  }
  if (!repository || !reference) return null;
  return { registry, repository, reference };
}

function authChallenge(value: string | null): { realm: string; service?: string; scope?: string } | null {
  if (!value || !/^Bearer\s/i.test(value)) return null;
  const get = (key: string) => value.match(new RegExp(`${key}="([^"]+)"`, "i"))?.[1];
  const realm = get("realm");
  if (!realm) return null;
  return { realm, service: get("service"), scope: get("scope") };
}

async function bearerToken(challenge: { realm: string; service?: string; scope?: string }): Promise<string | null> {
  try {
    const url = new URL(challenge.realm);
    if (challenge.service) url.searchParams.set("service", challenge.service);
    if (challenge.scope) url.searchParams.set("scope", challenge.scope);
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const body = (await response.json()) as { token?: string; access_token?: string };
    return body.token ?? body.access_token ?? null;
  } catch {
    return null;
  }
}

/** Query the registry v2 manifest digest without pulling image layers. */
export async function registryImageDigest(image: string): Promise<string | null> {
  const parsed = parseImageReference(image);
  if (!parsed) return null;
  const scheme = parsed.registry === "localhost" || parsed.registry.startsWith("127.") ? "http" : "https";
  const repository = parsed.repository.split("/").map(encodeURIComponent).join("/");
  const url = `${scheme}://${parsed.registry}/v2/${repository}/manifests/${encodeURIComponent(parsed.reference)}`;
  const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT };
  try {
    let response = await fetch(url, { method: "HEAD", headers, signal: AbortSignal.timeout(8000) });
    if (response.status === 401) {
      const challenge = authChallenge(response.headers.get("www-authenticate"));
      if (!challenge) return null;
      const token = await bearerToken(challenge);
      if (!token) return null;
      headers.Authorization = `Bearer ${token}`;
      response = await fetch(url, { method: "HEAD", headers, signal: AbortSignal.timeout(8000) });
    }
    if (!response.ok) return null;
    const headerDigest = response.headers.get("docker-content-digest");
    if (headerDigest) return headerDigest;

    // Some registries omit Docker-Content-Digest on HEAD; hash the exact
    // manifest bytes returned by GET as the v2 fallback.
    response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const body = Buffer.from(await response.arrayBuffer());
    return `sha256:${crypto.createHash("sha256").update(body).digest("hex")}`;
  } catch {
    return null;
  }
}

export function imageDigest(value: string | null | undefined): string | null {
  const match = value?.match(/sha256:[a-f0-9]{64}/i);
  return match?.[0].toLowerCase() ?? null;
}
