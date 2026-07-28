export interface ServiceAuthOptions {
  configuredOrigins?: string[];
  envOrigins?: string;
  defaultOrigin: string;
  tokenName: string;
}

/** Attach a bearer credential only when its destination matches a trusted origin. */
export function serviceAuthHeaderFor(
  destination: string,
  token: string | undefined,
  options: ServiceAuthOptions,
): Record<string, string> {
  const value = token?.trim();
  if (!value) return {};
  const origin = normalizeOrigin(destination);
  const allowed = options.configuredOrigins?.map(normalizeOrigin)
    ?? parseTrustedOrigins(options.envOrigins, options.defaultOrigin);
  if (!allowed.includes(origin)) {
    throw new Error(`Refusing to send ${options.tokenName} to untrusted origin: ${origin}`);
  }
  return { Authorization: `Bearer ${value}` };
}

export function parseTrustedOrigins(raw: string | undefined, fallback: string): string[] {
  return (raw ?? fallback)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeOrigin);
}

function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    return url.origin;
  } catch {
    throw new Error(`Invalid trusted service origin: ${value}`);
  }
}
