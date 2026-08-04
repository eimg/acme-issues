import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import {
  IssuesAuthError,
  type AuthRequest,
  type IssuesAuthAdapter,
  type IssuesPrincipal,
  type SessionResult,
} from "../src/auth.js";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { createProject } from "../src/projects.js";
import { WebhookDispatcher } from "../src/webhooks.js";

const HEADER = "x-acme-dev-user";

describe("Acme Issues identity permissions", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "acme-issues-auth-"));
  const db = openDatabase(dataDir);
  const principals: Record<string, string[]> = {
    admin: ["*"],
    viewer: ["issues.read"],
    member: ["issues.write"],
    custom: ["issues.*"],
    unrelated: ["projects.write"],
    steering: ["issues.steering.trigger"],
    receiver: ["issues.steering.receive"],
  };
  const authAdapter: IssuesAuthAdapter = {
    provider: "test",
    accountUrl: "http://identity.test/?tab=account",
    async resolve(request: AuthRequest) {
      const username = request.devUser ?? "admin";
      if (username === "signed-out") {
        throw new IssuesAuthError("Authentication required", "unauthenticated");
      }
      if (username === "outage") {
        throw new IssuesAuthError("Identity service unreachable", "unavailable");
      }
      return principal(username, principals[username] ?? []);
    },
    async signIn(_credentials, _request): Promise<SessionResult> {
      return {
        status: 201,
        body: { principal: principal("member", principals.member) },
        setCookie: "acme_identity_session=sess_test; HttpOnly; SameSite=Lax; Path=/",
      };
    },
    async signOut(): Promise<SessionResult> {
      return { status: 200, body: { signedOut: true } };
    },
  };
  const app = createApp({
    db,
    authAdapter,
    authMode: "off",
  });

  before(() => {
    createProject(db, { title: "Permission test", slug: "permission-test" });
  });

  after(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("requires a principal, fails closed on identity outages, and leaves health public", async () => {
    await request(app).get("/api/projects").set(HEADER, "signed-out").expect(401);
    await request(app).get("/api/projects").set(HEADER, "outage").expect(503);
    await request(app).get("/api/health").set(HEADER, "signed-out").expect(200);
  });

  it("lets readers inspect data but requires issues.write for mutations", async () => {
    await request(app).get("/api/projects").set(HEADER, "viewer").expect(200);
    const blocked = await request(app)
      .post("/api/projects/permission-test/issues")
      .set(HEADER, "viewer")
      .send({ title: "Viewer cannot create" })
      .expect(403);
    assert.match(blocked.body.error, /issues\.write/);

    await request(app).get("/api/projects").set(HEADER, "member").expect(200);
    await request(app)
      .post("/api/projects/permission-test/issues")
      .set(HEADER, "member")
      .send({ title: "Member can create" })
      .expect(201);
  });

  it("supports namespace permissions and rejects unrelated roles", async () => {
    await request(app)
      .post("/api/projects/permission-test/issues")
      .set(HEADER, "custom")
      .send({ title: "Future role" })
      .expect(201);
    await request(app).get("/api/projects").set(HEADER, "unrelated").expect(403);
  });

  it("proxies browser sessions and blocks cross-origin writes", async () => {
    const signedIn = await request(app)
      .post("/api/auth/session")
      .send({ username: "member", password: "member" })
      .expect(201);
    assert.match(String(signedIn.headers["set-cookie"]), /acme_identity_session=sess_test/);

    await request(app)
      .post("/api/auth/session")
      .set("origin", "https://malicious.example")
      .send({ username: "member", password: "member" })
      .expect(403);
  });

  it("requires issues.write for Helix callbacks", async () => {
    await request(app)
      .post("/api/webhooks/helix")
      .set(HEADER, "signed-out")
      .send({ event: "unknown.event" })
      .expect(401);
    await request(app)
      .post("/api/webhooks/helix")
      .set(HEADER, "member")
      .send({ event: "unknown.event" })
      .expect(200, { ok: true, ignored: true, event: "unknown.event" });
  });

  it("keeps the Steering trigger credential narrower than ordinary issue writes", async () => {
    const action = {
      schemaVersion: "acme.steering.action.v1", requestId: "auth-test", caseId: "case", decisionId: "decision",
      actionKey: "issues.trigger_implementation", resource: { type: "issue", id: "9999", expectedRevision: "1" },
    };
    await request(app).post("/api/steering/actions").set(HEADER, "member").send(action).expect(403);
    await request(app).post("/api/steering/actions").set(HEADER, "steering").send(action).expect(404);
    await request(app).post("/api/projects/permission-test/issues").set(HEADER, "steering").send({ title: "No broad write" }).expect(403);
    await request(app).post("/api/steering/decisions").set(HEADER, "steering").send({}).expect(403);
    await request(app).post("/api/steering/decisions").set(HEADER, "receiver").send({}).expect(400);
    await request(app).post("/api/steering/actions").set(HEADER, "receiver").send(action).expect(403);
  });

  it("does not send the Helix token to an untrusted project webhook", async () => {
    const project = createProject(db, {
      title: "Untrusted",
      slug: "untrusted",
      webhookUrl: "https://attacker.example/runs",
      webhookEnabled: true,
      labelFilter: "trigger",
    });
    let called = false;
    const dispatcher = new WebhookDispatcher({
      db,
      authToken: "svc_secret",
      trustedOrigins: ["http://127.0.0.1:8319"],
      fetchFn: async () => {
        called = true;
        return Response.json({});
      },
    });
    const issue = (await request(app)
      .post(`/api/projects/${project.slug}/issues`)
      .set(HEADER, "member")
      .send({ title: "Do not leak", labels: [] })
      .expect(201)).body.issue;
    const delivery = await dispatcher.dispatchForIssue(
      { ...issue, labels: ["trigger"] },
      "security-test",
    );
    assert.equal(delivery?.success, false);
    assert.match(delivery?.error ?? "", /untrusted origin/);
    assert.equal(called, false);
  });
});

function principal(username: string, permissions: string[]): IssuesPrincipal {
  return {
    schemaVersion: "acme.principal.v1",
    sub: `dev:${username}`,
    iss: "acme-identity",
    username,
    displayName: username,
    email: `${username}@acme.local`,
    roles: [username],
    permissions,
    kind: "dev",
    authMode: "off",
  };
}
