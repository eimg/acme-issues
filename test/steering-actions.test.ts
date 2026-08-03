import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { createIssue, getIssueById } from "../src/issues.js";
import { createProject } from "../src/projects.js";
import { WebhookDispatcher } from "../src/webhooks.js";

let dataDir: string;
let db: ReturnType<typeof openDatabase>;
before(() => { dataDir = mkdtempSync(join(tmpdir(), "issues-steering-")); db = openDatabase(dataDir); });
after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });

it("applies and deduplicates the implementation-trigger action", async () => {
  const project = createProject(db, { title: "Default", slug: "default", webhookUrl: "http://helix.test/runs", labelFilter: "trigger", commentTrigger: "/helix", webhookEnabled: true, baseUrl: "http://issues.test" });
  const issue = createIssue(db, project, { title: "Ready issue", status: "open", labels: ["trigger"] });
  const fetchFn: typeof fetch = async () => Response.json({ id: "run-1", status: "running" }, { status: 202 });
  const app = createApp({ db, dispatcher: new WebhookDispatcher({ db, fetchFn }), fetchFn });
  const body = {
    schemaVersion: "acme.steering.action.v1", requestId: "req-1", caseId: "case-1", decisionId: "decision-1",
    actionKey: "issues.trigger_implementation",
    resource: { type: "issue", id: String(issue.id), expectedRevision: String(issue.updatedAt) },
  };
  const applied = await request(app).post("/api/steering/actions").send(body).expect(200);
  assert.equal(applied.body.status, "applied");
  const duplicate = await request(app).post("/api/steering/actions").send(body).expect(200);
  assert.equal(duplicate.body.status, "already_applied");
});

it("records a Steering disposition while Issues retains workflow ownership", async () => {
  const project = createProject(db, { title: "Decision project", slug: "decision-project" });
  const issue = createIssue(db, project, { title: "Revise me", status: "open" });
  const app = createApp({ db });
  const body = decisionBody("issues.trigger_implementation", "issue", String(issue.id), String(issue.updatedAt));
  await request(app).post("/api/steering/decisions").send(body).expect(202).expect(({ body: receipt }) => assert.equal(receipt.status, "recorded"));
  await request(app).post("/api/steering/decisions").send(body).expect(200).expect(({ body: receipt }) => assert.equal(receipt.status, "already_recorded"));
  const listed = await request(app).get(`/api/steering/decisions?resourceType=issue&resourceId=${issue.id}`).expect(200);
  assert.equal(listed.body.items[0].resolution, "request_revision");
  assert.equal(getIssueById(db, issue.id)?.issue.status, "open");
  const comments = await request(app).get(`/api/projects/${project.slug}/issues/${issue.id}/comments`).expect(200);
  assert.equal(comments.body.length, 1);
  assert.match(comments.body[0].body, /Steering decision: request revision/);
  assert.match(comments.body[0].body, /Clarify the implementation boundary/);
});

function decisionBody(actionKey: string, type: string, id: string, expectedRevision: string) {
  return {
    schemaVersion: "acme.steering.decision.v1", decisionId: `decision-${id}`, caseId: `case-${id}`,
    actionKey, resolution: "request_revision", rationale: "Clarify the implementation boundary.",
    decidedAt: "2026-08-03T00:00:00.000Z",
    actor: { id: "identity:admin", issuer: "acme-identity", username: "admin", displayName: "Administrator", kind: "human" },
    resource: { type, id, expectedRevision },
  };
}
