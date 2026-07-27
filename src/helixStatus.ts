import type { Project } from "./types.js";

export type HelixReachability = "online" | "offline" | "unconfigured";

/** Live Helix target status for an Issues project (soft coupling via /health). */
export interface HelixStatus {
  status: HelixReachability;
  webhookEnabled: boolean;
  webhookUrl: string;
  healthUrl: string | null;
  checkedAt: number;
}

/** Derive Helix `/health` from the configured `…/runs` webhook URL. */
export function helixHealthUrl(webhookUrl: string): string | undefined {
  const normalized = webhookUrl.trim().replace(/\/+$/, "");
  if (!normalized.endsWith("/runs")) return undefined;
  return `${normalized.slice(0, -"/runs".length)}/health`;
}

export async function probeHelixStatus(
  project: Project,
  fetchFn: typeof fetch = fetch,
): Promise<HelixStatus> {
  const checkedAt = Date.now();
  const webhookUrl = project.webhookUrl.trim();
  const healthUrl = helixHealthUrl(webhookUrl) ?? null;
  const base = {
    webhookEnabled: project.webhookEnabled,
    webhookUrl,
    healthUrl,
    checkedAt,
  };

  if (!healthUrl) {
    return { ...base, status: "unconfigured" };
  }

  try {
    const res = await fetchFn(healthUrl, {
      method: "GET",
      signal: AbortSignal.timeout(2_500),
    });
    if (!res.ok || res.status !== 200) return { ...base, status: "offline" };
    const body = await res.json().catch(() => null) as { ok?: unknown } | null;
    if (body && body.ok === true) return { ...base, status: "online" };
    return { ...base, status: "offline" };
  } catch {
    return { ...base, status: "offline" };
  }
}
