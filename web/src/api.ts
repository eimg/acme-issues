export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(body.error || response.statusText);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function projectApiPath(projectRef: string, suffix = ""): string {
  const base = `/api/projects/${encodeURIComponent(projectRef)}`;
  if (!suffix) return base;
  return suffix.startsWith("/") ? `${base}${suffix}` : `${base}/${suffix}`;
}

export function formatStatus(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatTime(value?: number): string {
  return value ? new Date(value).toLocaleString() : "—";
}
