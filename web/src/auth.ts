export type AuthMode = "off" | "local";

export type Principal = {
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

export function hasPermission(
  principal: Pick<Principal, "permissions">,
  requested: string,
): boolean {
  const req = requested.trim().toLowerCase();
  return principal.permissions.some((granted) => {
    const g = granted.trim().toLowerCase();
    return g === "*" || g === req || (g.endsWith(".*") && req.startsWith(g.slice(0, -1)));
  });
}
