import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { createIssue } from "../src/issues.js";
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
