import type {
  NextFunction,
  Request,
  RequestHandler,
  Response as ExpressResponse,
} from "express";

/** Off-mode test header: select which synthetic principal to resolve. */
export const DEV_USER_HEADER = "x-acme-dev-user";

export type AuthMode = "off" | "local";

/** Product-owned principal; wire-compatible with Identity's acme.principal.v1 for the session UI. */
export type IssuesPrincipal = {
  schemaVersion: "acme.principal.v1";
  sub: string;
  iss: string;
  username: string;
  displayName: string;
  email: string;
  roles: string[];
  permissions: string[];
  kind: "user" | "service" | "dev";
  authMode: AuthMode;
};

export type AuthRequest = {
  authorization?: string;
  cookie?: string;
  devUser?: string;
};

export type SessionResult = {
  status: number;
  body: unknown;
  setCookie?: string;
};

/** Issues-owned seam. Providers translate native identity into IssuesPrincipal. */
export interface IssuesAuthAdapter {
  readonly provider: string;
  readonly accountUrl?: string;
  resolve(request: AuthRequest): Promise<IssuesPrincipal>;
  signIn?(credentials: unknown, request: AuthRequest): Promise<SessionResult>;
  signOut?(request: AuthRequest): Promise<SessionResult>;
}

export class IssuesAuthError extends Error {
  constructor(
    message: string,
    readonly code: "unauthenticated" | "unavailable" | "config",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "IssuesAuthError";
  }
}

export type AuthLocals = { principal?: IssuesPrincipal };

const ISSUES_CAPABILITIES = ["issues.read", "issues.write"];

const offAdminPrincipal: IssuesPrincipal = {
  schemaVersion: "acme.principal.v1",
  sub: "dev:admin",
  iss: "acme-issues",
  username: "admin",
  displayName: "Local Issues operator",
  email: "admin@acme.local",
  roles: ["admin"],
  permissions: ["*"],
  kind: "dev",
  authMode: "off",
};

export function authMode(raw = process.env.ACME_AUTH_MODE): AuthMode {
  const mode = (raw ?? "off").trim().toLowerCase();
  if (mode === "off" || mode === "local") return mode;
  throw new IssuesAuthError(
    `ACME_AUTH_MODE must be "off" or "local" (got ${JSON.stringify(raw)})`,
    "config",
  );
}

export function identityBaseUrl(
  raw = process.env.ACME_IDENTITY_URL ?? "http://127.0.0.1:8316",
): string {
  return raw.replace(/\/$/, "");
}

export function createOffAuthAdapter(): IssuesAuthAdapter {
  return {
    provider: "off",
    async resolve() {
      return offAdminPrincipal;
    },
  };
}

export function createAcmeIdentityAuthAdapter({
  baseUrl = identityBaseUrl(),
  fetchFn = fetch,
  timeoutMs = 3_000,
  mode = "local" as AuthMode,
}: {
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  mode?: AuthMode;
} = {}): IssuesAuthAdapter {
  const identityUrl = baseUrl.replace(/\/$/, "");

  const call = async (
    path: string,
    init: RequestInit,
    unavailableMessage: string,
  ): Promise<globalThis.Response> => {
    try {
      return await fetchFn(`${identityUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new IssuesAuthError(unavailableMessage, "unavailable", { cause: error });
    }
  };

  return {
    provider: "acme-identity",
    accountUrl: `${identityUrl}/?tab=account`,
    async resolve(request) {
      const response = await call(
        "/api/principal",
        { method: "GET", headers: forwardedHeaders(request) },
        `Authentication provider unavailable at ${identityUrl}`,
      );
      if (response.status === 401) {
        throw new IssuesAuthError("Authentication required", "unauthenticated");
      }
      if (!response.ok) {
        throw new IssuesAuthError(
          `Authentication provider lookup failed (${response.status})`,
          "unavailable",
        );
      }
      return translateAcmePrincipal(await response.json(), mode);
    },
    async signIn(credentials, request) {
      const response = await call(
        "/api/session",
        {
          method: "POST",
          headers: { "content-type": "application/json", ...forwardedHeaders(request) },
          body: JSON.stringify(credentials ?? {}),
        },
        `Authentication provider unavailable at ${identityUrl}`,
      );
      return sessionResult(response);
    },
    async signOut(request) {
      const response = await call(
        "/api/session",
        { method: "DELETE", headers: forwardedHeaders(request) },
        `Authentication provider unavailable at ${identityUrl}`,
      );
      return sessionResult(response);
    },
  };
}

export function createAuthAdapterFromEnv(
  mode: AuthMode = authMode(),
  opts: { identityFetchFn?: typeof fetch; identityUrl?: string } = {},
): IssuesAuthAdapter {
  if (mode === "off") return createOffAuthAdapter();
  return createAcmeIdentityAuthAdapter({
    baseUrl: opts.identityUrl ?? identityBaseUrl(),
    fetchFn: opts.identityFetchFn,
    mode,
  });
}

export function authenticateRequests(adapter: IssuesAuthAdapter): RequestHandler {
  return async (req, res, next) => {
    try {
      (res.locals as AuthLocals).principal = await adapter.resolve(authRequest(req));
      next();
    } catch (error) {
      authError(res, error);
    }
  };
}

export function authorizeIssuesRequest(req: Request, res: ExpressResponse, next: NextFunction): void {
  const principal = (res.locals as AuthLocals).principal;
  if (!principal) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    if (hasAnyPermission(principal, ISSUES_CAPABILITIES)) {
      next();
      return;
    }
    res.status(403).json({ error: "Missing permission: issues.read or issues.write" });
    return;
  }

  if (req.method === "POST" && req.path === "/steering/actions") {
    if (hasPermission(principal, "issues.steering.trigger")) {
      next();
      return;
    }
    res.status(403).json({ error: "Missing permission: issues.steering.trigger" });
    return;
  }
  if (req.method === "POST" && req.path === "/steering/decisions") {
    if (hasPermission(principal, "issues.steering.receive")) {
      next();
      return;
    }
    res.status(403).json({ error: "Missing permission: issues.steering.receive" });
    return;
  }

  if (!hasPermission(principal, "issues.write")) {
    res.status(403).json({ error: "Missing permission: issues.write" });
    return;
  }
  next();
}

export function principalFrom(res: ExpressResponse): IssuesPrincipal {
  return (res.locals as AuthLocals).principal!;
}

/** Prevent another browser origin from driving Issues writes with the shared identity cookie. */
export function sameOriginWrites(): RequestHandler {
  return (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    const site = req.headers["sec-fetch-site"];
    if (site === "same-origin" || site === "none") {
      next();
      return;
    }
    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }
    const expected = `${req.protocol}://${req.headers.host ?? ""}`;
    if (origin.replace(/\/$/, "") === expected) {
      next();
      return;
    }
    res.status(403).json({ error: "Cross-origin request blocked" });
  };
}

export function hasPermission(
  principal: Pick<IssuesPrincipal, "permissions">,
  requested: string,
): boolean {
  const req = requested.trim().toLowerCase();
  return principal.permissions.some((granted) => {
    const g = granted.trim().toLowerCase();
    return g === "*" || g === req || (g.endsWith(".*") && req.startsWith(g.slice(0, -1)));
  });
}

export function hasAnyPermission(
  principal: Pick<IssuesPrincipal, "permissions">,
  permissions: string[],
): boolean {
  return permissions.some((permission) => hasPermission(principal, permission));
}

export function authRequest(req: Request): AuthRequest {
  return {
    authorization: req.headers.authorization,
    cookie: req.headers.cookie,
    devUser: header(req, DEV_USER_HEADER),
  };
}

export async function handleSessionSignIn(
  adapter: IssuesAuthAdapter,
  credentials: unknown,
  request: AuthRequest,
  res: ExpressResponse,
): Promise<void> {
  if (!adapter.signIn) {
    res.status(405).json({ error: "Interactive sign-in is unavailable for this auth mode" });
    return;
  }
  try {
    sendSessionResult(res, await adapter.signIn(credentials, request));
  } catch (error) {
    authError(res, error);
  }
}

export async function handleSessionSignOut(
  adapter: IssuesAuthAdapter,
  request: AuthRequest,
  res: ExpressResponse,
): Promise<void> {
  if (!adapter.signOut) {
    res.json({ schemaVersion: "acme.session.v1", signedOut: true });
    return;
  }
  try {
    sendSessionResult(res, await adapter.signOut(request));
  } catch (error) {
    authError(res, error);
  }
}

function forwardedHeaders(request: AuthRequest): Record<string, string> {
  return {
    ...(request.authorization ? { authorization: request.authorization } : {}),
    ...(request.cookie ? { cookie: request.cookie } : {}),
  };
}

async function sessionResult(response: globalThis.Response): Promise<SessionResult> {
  return {
    status: response.status,
    body: await response.json().catch(() => ({ error: response.statusText })),
    setCookie: response.headers.get("set-cookie") ?? undefined,
  };
}

function sendSessionResult(res: ExpressResponse, result: SessionResult): void {
  if (result.setCookie) res.setHeader("set-cookie", result.setCookie);
  res.status(result.status).json(result.body);
}

function authError(res: ExpressResponse, error: unknown): void {
  const status = error instanceof IssuesAuthError && error.code === "unauthenticated" ? 401 : 503;
  res.status(status).json({
    error: error instanceof Error ? error.message : "Authentication required",
  });
}

function translateAcmePrincipal(value: unknown, mode: AuthMode): IssuesPrincipal {
  if (!value || typeof value !== "object") {
    throw new IssuesAuthError("Authentication provider returned an invalid principal", "unavailable");
  }
  const principal = value as Record<string, unknown>;
  const sub = text(principal.sub);
  const issuer = text(principal.iss);
  const username = text(principal.username);
  const displayName = text(principal.displayName);
  const email = typeof principal.email === "string" ? principal.email.trim() : "";
  const roles = strings(principal.roles);
  const permissions = strings(principal.permissions);
  if (!sub || !issuer || !username || !displayName || !roles || !permissions) {
    throw new IssuesAuthError("Authentication provider returned an invalid principal", "unavailable");
  }
  const kind = principal.kind === "service" ? "service" : principal.kind === "dev" ? "dev" : "user";
  return {
    schemaVersion: "acme.principal.v1",
    sub,
    iss: issuer,
    username,
    displayName,
    email,
    roles,
    permissions,
    kind,
    authMode: mode,
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value.map((item) => item.trim()).filter(Boolean)
    : undefined;
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}
