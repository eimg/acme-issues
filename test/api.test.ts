import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { openDatabase } from "../src/db.js";
import { createApp } from "../src/app.js";
import { WebhookDispatcher } from "../src/webhooks.js";
import { createProject } from "../src/projects.js";

describe("acme-issues API", () => {
  let dataDir: string;
  let db: ReturnType<typeof openDatabase>;
  let app: ReturnType<typeof createApp>;
  let webhookCalls: { url: string; body: unknown }[];
  let projectsLifecycleCalls: { url: string; body: unknown }[];

  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), "acme-issues-"));
    db = openDatabase(dataDir);
    createProject(db, {
      title: "Default",
      slug: "default",
      webhookUrl: "http://helix.test/runs",
      labelFilter: "trigger",
      commentTrigger: "/helix",
      webhookEnabled: true,
      baseUrl: "http://127.0.0.1:8320",
    });

    webhookCalls = [];
    projectsLifecycleCalls = [];
    const fetchFn: typeof fetch = async (url, init) => {
      const href = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (href.includes("/api/webhooks/issues")) {
        projectsLifecycleCalls.push({ url: href, body });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (href.includes("steering.test/api/health")) {
        return Response.json({ ok: true, product: "acme-steering" });
      }
      if (href.includes("steering.test/api/notifications/check")) {
        return Response.json({ ok: true, product: "acme-issues" });
      }
      webhookCalls.push({ url: href, body });
      if (href.includes("/continuations")) {
        return new Response(
          JSON.stringify({ id: `child-run-${webhookCalls.length}`, status: "running" }),
          { status: 202 },
        );
      }
      if (href.endsWith("/workspace")) {
        return new Response(JSON.stringify({ cwd: "/tmp/helix-workspace" }), { status: 200 });
      }
      if (href.endsWith("/local-prs/merge")) {
        return new Response(
          JSON.stringify({ error: "Helix merge not stubbed for this test" }),
          { status: 501 },
        );
      }
      return new Response(JSON.stringify({ ok: true, id: `run-${webhookCalls.length}` }), { status: 202 });
    };
    const dispatcher = new WebhookDispatcher({ db, fetchFn });
    app = createApp({ db, dispatcher, fetchFn });
  });

  after(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("manages and tests the optional Steering connection without storing credentials", async () => {
    const saved = await request(app)
      .patch("/api/integrations/steering")
      .send({ url: "http://steering.test/" })
      .expect(200);
    assert.equal(saved.body.url, "http://steering.test");
    assert.equal(saved.body.source, "stored");
    assert.equal(saved.body.status, "online");

    const tested = await request(app).post("/api/integrations/steering/test").expect(200);
    assert.equal(tested.body.status, "online");
    assert.equal(Object.hasOwn(tested.body, "token"), false);

    const disabled = await request(app)
      .patch("/api/integrations/steering")
      .send({ url: "" })
      .expect(200);
    assert.equal(disabled.body.configured, false);
    assert.equal(disabled.body.source, "stored");

    const reset = await request(app)
      .patch("/api/integrations/steering")
      .send({ url: null })
      .expect(200);
    assert.equal(reset.body.source, "unconfigured");
  });

  it("manages projects and isolates nested resources", async () => {
    const listed = await request(app).get("/api/projects").expect(200);
    assert.ok(listed.body.some((p: { slug: string }) => p.slug === "default"));

    const created = await request(app)
      .post("/api/projects")
      .send({
        title: "Acme Todo",
        slug: "acme-todo",
        webhookUrl: "http://helix.other/runs",
        webhookEnabled: true,
        baseUrl: "http://127.0.0.1:8320",
      })
      .expect(201);
    assert.equal(created.body.slug, "acme-todo");
    assert.equal(created.body.title, "Acme Todo");

    const issueA = await request(app)
      .post("/api/projects/default/issues")
      .send({ title: "Only in default", labels: [] })
      .expect(201);
    const issueB = await request(app)
      .post("/api/projects/acme-todo/issues")
      .send({ title: "Only in todo", labels: [] })
      .expect(201);

    const defaultIssues = await request(app).get("/api/projects/default/issues").expect(200);
    assert.ok(defaultIssues.body.items.some((i: { id: number }) => i.id === issueA.body.issue.id));
    assert.ok(!defaultIssues.body.items.some((i: { id: number }) => i.id === issueB.body.issue.id));

    await request(app).get(`/api/projects/acme-todo/issues/${issueA.body.issue.id}`).expect(404);

    const patched = await request(app)
      .patch("/api/projects/acme-todo")
      .send({ title: "Acme Todo App", labelFilter: "ship" })
      .expect(200);
    assert.equal(patched.body.title, "Acme Todo App");
    assert.equal(patched.body.labelFilter, "ship");

    await request(app).delete("/api/projects/acme-todo").expect(204);
    await request(app).get("/api/projects/acme-todo").expect(404);
    await request(app).get(`/api/projects/default/issues/${issueB.body.issue.id}`).expect(404);
  });

  it("notifies Acme Projects on linked-issue lifecycle transitions", async () => {
    projectsLifecycleCalls.length = 0;
    const created = await request(app)
      .post("/api/projects/default/issues")
      .send({
        title: "From Projects",
        labels: [],
        sourceCardId: "42",
        projectsCallbackUrl: "http://projects.test/api/webhooks/issues",
      })
      .expect(201);
    const issueId = created.body.issue.id as number;
    assert.equal(created.body.issue.sourceCardId, "42");
    assert.equal(created.body.issue.projectsCallbackUrl, "http://projects.test/api/webhooks/issues");
    assert.equal(created.body.issue.status, "open");

    const triggered = await request(app)
      .patch(`/api/projects/default/issues/${issueId}`)
      .send({ labels: ["trigger"] })
      .expect(200);
    assert.equal(triggered.body.issue.status, "in_progress");
    assert.equal(triggered.body.delivery.success, true);

    assert.equal(projectsLifecycleCalls.length, 1);
    assert.equal(
      (projectsLifecycleCalls[0].body as { event: string }).event,
      "implementation.started",
    );

    const pr = await request(app)
      .post("/api/projects/default/pull-requests")
      .send({
        issueId,
        title: "PR for projects card",
        repositoryPath: "/tmp/example-repo",
        baseBranch: "main",
        baseSha: "base",
        headBranch: "feature/projects",
        headSha: "head",
        origin: "helix",
      })
      .expect(201);

    assert.equal(projectsLifecycleCalls.length, 2);
    assert.equal(
      (projectsLifecycleCalls[1].body as { event: string }).event,
      "implementation.in_review",
    );

    await request(app).post("/api/webhooks/helix").send({
      event: "pr.review.completed",
      review: {
        id: "review-projects",
        status: "completed",
        headSha: "head",
        startedAt: 1,
        finishedAt: 2,
        decision: "ready_to_merge",
        summary: "ready",
      },
      pullRequest: { id: pr.body.id },
    }).expect(200);

    await request(app)
      .patch(`/api/projects/default/pull-requests/${pr.body.id}`)
      .send({ status: "merged", mergeCommitSha: "merge-sha" })
      .expect(200);

    assert.equal(projectsLifecycleCalls.length, 3);
    assert.equal(
      (projectsLifecycleCalls[2].body as { event: string }).event,
      "implementation.completed",
    );
    assert.equal((projectsLifecycleCalls[2].body as { sourceCardId: string }).sourceCardId, "42");
  });

  it("creates an issue and auto-triggers webhook when filter label present", async () => {
    webhookCalls.length = 0;
    const res = await request(app)
      .post("/api/projects/default/issues")
      .send({ title: "Fix login", body: "Empty password returns 500", labels: ["trigger"] })
      .expect(201);

    assert.equal(res.body.issue.title, "Fix login");
    assert.deepEqual(res.body.issue.labels, ["trigger"]);
    assert.equal(webhookCalls.length, 1);
    assert.deepEqual(webhookCalls[0].body, {
      title: "Fix login",
      body: "Empty password returns 500",
      labels: ["trigger"],
      external: {
        trackerUrl: "http://127.0.0.1:8320",
        issueId: res.body.issue.id,
        projectId: res.body.issue.projectId,
        projectSlug: "default",
      },
    });
    assert.equal(res.body.delivery.success, true);
    assert.equal(res.body.issue.status, "in_progress");
  });

  it("does not auto-trigger without filter label", async () => {
    webhookCalls.length = 0;
    const res = await request(app)
      .post("/api/projects/default/issues")
      .send({ title: "Docs typo", labels: ["docs"] })
      .expect(201);

    assert.equal(webhookCalls.length, 0);
    assert.equal(res.body.delivery, null);
  });

  it("triggers webhook when filter label is added later", async () => {
    const created = await request(app)
      .post("/api/projects/default/issues")
      .send({ title: "Later label", labels: ["bug"] })
      .expect(201);

    webhookCalls.length = 0;
    const updated = await request(app)
      .patch(`/api/projects/default/issues/${created.body.issue.id}`)
      .send({ labels: ["bug", "trigger"] })
      .expect(200);

    assert.equal(webhookCalls.length, 1);
    assert.equal(updated.body.delivery.success, true);
    assert.equal(updated.body.issue.status, "in_progress");
  });

  it("manual trigger works for any open issue", async () => {
    const created = await request(app)
      .post("/api/projects/default/issues")
      .send({ title: "Manual", labels: [] })
      .expect(201);

    webhookCalls.length = 0;
    const res = await request(app)
      .post(`/api/projects/default/issues/${created.body.issue.id}/trigger`)
      .expect(200);

    assert.equal(webhookCalls.length, 1);
    assert.equal(res.body.delivery.success, true);
    assert.equal(res.body.issue.status, "in_progress");
  });

  it("lists deliveries and supports remove/clear", async () => {
    const res = await request(app).get("/api/projects/default/webhooks/deliveries").expect(200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length > 0);

    const firstId = res.body[0].id as number;
    await request(app).delete(`/api/projects/default/webhooks/deliveries/${firstId}`).expect(204);
    await request(app).delete(`/api/projects/default/webhooks/deliveries/${firstId}`).expect(404);

    const afterOne = await request(app).get("/api/projects/default/webhooks/deliveries").expect(200);
    assert.ok(!afterOne.body.some((d: { id: number }) => d.id === firstId));

    const cleared = await request(app).delete("/api/projects/default/webhooks/deliveries").expect(200);
    assert.ok(cleared.body.deleted >= 0);

    const empty = await request(app).get("/api/projects/default/webhooks/deliveries").expect(200);
    assert.equal(empty.body.length, 0);
  });

  it("supports full comment CRUD on an issue", async () => {
    const created = await request(app)
      .post("/api/projects/default/issues")
      .send({ title: "With comments", labels: [] })
      .expect(201);

    const issueId = created.body.issue.id as number;

    const createdComment = await request(app)
      .post(`/api/projects/default/issues/${issueId}/comments`)
      .send({ body: "First note", author: "alice" })
      .expect(201);

    assert.equal(createdComment.body.body, "First note");
    assert.equal(createdComment.body.author, "alice");
    assert.equal(createdComment.body.source, "user");
    assert.equal(createdComment.body.issueId, issueId);

    const listed = await request(app).get(`/api/projects/default/issues/${issueId}/comments`).expect(200);
    assert.equal(listed.body.length, 1);
    assert.equal(listed.body[0].id, createdComment.body.id);

    const updated = await request(app)
      .patch(`/api/projects/default/issues/${issueId}/comments/${createdComment.body.id}`)
      .send({ body: "Updated note" })
      .expect(200);

    assert.equal(updated.body.body, "Updated note");
    assert.equal(updated.body.author, "alice");

    await request(app)
      .delete(`/api/projects/default/issues/${issueId}/comments/${createdComment.body.id}`)
      .expect(204);

    const afterDelete = await request(app).get(`/api/projects/default/issues/${issueId}/comments`).expect(200);
    assert.equal(afterDelete.body.length, 0);
  });

  it("rejects invalid comment create/update and mismatched issue ids", async () => {
    const created = await request(app)
      .post("/api/projects/default/issues")
      .send({ title: "Comment validation", labels: [] })
      .expect(201);
    const other = await request(app)
      .post("/api/projects/default/issues")
      .send({ title: "Other issue", labels: [] })
      .expect(201);

    const issueId = created.body.issue.id as number;
    const otherId = other.body.issue.id as number;

    await request(app)
      .post(`/api/projects/default/issues/${issueId}/comments`)
      .send({ body: "   " })
      .expect(400);

    const comment = await request(app)
      .post(`/api/projects/default/issues/${issueId}/comments`)
      .send({ body: "Keep me" })
      .expect(201);

    await request(app)
      .patch(`/api/projects/default/issues/${issueId}/comments/${comment.body.id}`)
      .send({ body: "" })
      .expect(400);

    await request(app)
      .patch(`/api/projects/default/issues/${otherId}/comments/${comment.body.id}`)
      .send({ body: "Nope" })
      .expect(404);

    await request(app)
      .delete(`/api/projects/default/issues/${otherId}/comments/${comment.body.id}`)
      .expect(404);

    await request(app).post("/api/projects/default/issues/99999/comments").send({ body: "missing" }).expect(404);
  });

  it("reports Helix target reachability for a project", async () => {
    const offline = await request(app).get("/api/projects/default/helix").expect(200);
    assert.equal(offline.body.status, "offline");
    assert.equal(offline.body.healthUrl, "http://helix.test/health");
    assert.equal(offline.body.webhookEnabled, true);

    const fetchFn: typeof fetch = async (url) => {
      if (String(url) === "http://helix.test/health") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };
    const onlineApp = createApp({ db, fetchFn });
    const online = await request(onlineApp).get("/api/projects/default/helix").expect(200);
    assert.equal(online.body.status, "online");

    await request(app)
      .patch("/api/projects/default")
      .send({ webhookUrl: "http://not-helix.example/hooks" })
      .expect(200);
    const unconfigured = await request(app).get("/api/projects/default/helix").expect(200);
    assert.equal(unconfigured.body.status, "unconfigured");
    assert.equal(unconfigured.body.healthUrl, null);

    await request(app)
      .patch("/api/projects/default")
      .send({ webhookUrl: "http://helix.test/runs" })
      .expect(200);
  });

  it("accepts Helix flat /api/pull-requests without a project path", async () => {
    const issue = await request(app)
      .post("/api/projects/default/issues")
      .send({ title: "Flat PR issue", labels: ["trigger"] })
      .expect(201);
    const issueId = issue.body.issue.id as number;

    const created = await request(app)
      .post("/api/pull-requests")
      .send({
        issueId,
        title: "Helix draft",
        repositoryPath: "/tmp/example-repo",
        baseBranch: "main",
        baseSha: "base",
        headBranch: "feature/flat",
        headSha: "head-flat",
        author: "helix",
        origin: "helix",
      })
      .expect(201);

    assert.equal(created.body.issueId, issueId);
    assert.equal(created.body.projectId, 1);

    const fetched = await request(app).get(`/api/pull-requests/${created.body.id}`).expect(200);
    assert.equal(fetched.body.project.slug, "default");
    assert.equal(fetched.body.headSha, "head-flat");

    const patched = await request(app)
      .patch(`/api/pull-requests/${created.body.id}`)
      .send({ headSha: "head-flat-2", description: "continued" })
      .expect(200);
    assert.equal(patched.body.headSha, "head-flat-2");
    assert.equal(patched.body.description, "continued");
  });

  it("marks issue in_progress on helix run.started and closes on run.completed", async () => {
    const created = await request(app)
      .post("/api/projects/default/issues")
      .send({ title: "To progress", labels: [] })
      .expect(201);

    const issueId = created.body.issue.id as number;
    assert.equal(created.body.issue.status, "open");
    const started = await request(app)
      .post("/api/webhooks/helix")
      .set("X-Helix-Event", "run.started")
      .send({
        event: "run.started",
        run: { id: "run-abc-123", status: "running", startedAt: Date.now() },
        issue: { id: issueId, title: "To progress" },
      })
      .expect(200);

    assert.equal(started.body.issue.status, "in_progress");
    assert.match(started.body.comment.body, /in progress/i);

    const completed = await request(app)
      .post("/api/webhooks/helix")
      .set("X-Helix-Event", "run.completed")
      .send({
        event: "run.completed",
        run: {
          id: "run-abc-123",
          status: "done",
          startedAt: Date.now() - 5000,
          finishedAt: Date.now(),
        },
        issue: { id: issueId, title: "To progress" },
      })
      .expect(200);

    assert.equal(completed.body.issue.status, "closed");
    assert.equal(completed.body.comment.author, "helix");
    assert.equal(completed.body.comment.source, "helix.webhook");
    assert.match(completed.body.comment.body, /Closed automatically/);
    assert.match(completed.body.comment.body, /run-abc/);
    assert.doesNotMatch(completed.body.comment.body, /Event:/);

    const comments = await request(app).get(`/api/projects/default/issues/${issueId}/comments`).expect(200);
    assert.equal(comments.body.length, 2);
    assert.equal(comments.body[0].source, "helix.webhook");
    assert.equal(comments.body[1].source, "helix.webhook");

    const got = await request(app).get(`/api/projects/default/issues/${issueId}`).expect(200);
    assert.equal(got.body.status, "closed");
  });

  it("sends /helix comments as linked continuations and reopens the issue", async () => {
    const created = await request(app)
      .post("/api/projects/default/issues")
      .send({ title: "Continue me", body: "Original work", labels: ["trigger"] })
      .expect(201);
    const issueId = created.body.issue.id as number;

    await request(app)
      .post("/api/webhooks/helix")
      .set("X-Helix-Event", "run.completed")
      .send({
        event: "run.completed",
        run: { id: "root-run", status: "done", startedAt: 100, finishedAt: 200 },
        issue: { id: issueId, title: "Continue me" },
      })
      .expect(200);

    webhookCalls.length = 0;
    const comment = await request(app)
      .post(`/api/projects/default/issues/${issueId}/comments`)
      .send({ body: "/helix also cover the regression case", author: "alice" })
      .expect(201);

    assert.equal(comment.body.issue.status, "in_progress");
    assert.equal(comment.body.delivery.success, true);
    assert.equal(webhookCalls.length, 1);
    assert.equal(webhookCalls[0].url, "http://helix.test/runs/root-run/continuations");
    assert.deepEqual(webhookCalls[0].body, {
      instruction: "also cover the regression case",
      externalEventId: `comment:${comment.body.id}`,
      trigger: "issue.comment",
      projectId: created.body.issue.projectId,
      projectSlug: "default",
    });

    const detail = await request(app).get(`/api/projects/default/issues/${issueId}`).expect(200);
    assert.equal(detail.body.helix.activeRun.trigger, "issue.comment");
    assert.equal(detail.body.status, "in_progress");
  });

  it("reopen targets the latest completed Helix run", async () => {
    const created = await request(app)
      .post("/api/projects/default/issues")
      .send({ title: "Reopen me", labels: ["trigger"] })
      .expect(201);
    const issueId = created.body.issue.id as number;

    await request(app).post("/api/webhooks/helix").set("X-Helix-Event", "run.completed").send({
      event: "run.completed",
      run: {
        id: "continuation-two",
        parentRunId: "root-one",
        rootRunId: "root-one",
        status: "done",
        startedAt: 300,
        finishedAt: 400,
      },
      issue: { id: issueId, title: "Reopen me" },
    }).expect(200);

    webhookCalls.length = 0;
    const reopened = await request(app)
      .patch(`/api/projects/default/issues/${issueId}`)
      .send({ status: "open" })
      .expect(200);

    assert.equal(reopened.body.delivery.success, true);
    assert.equal(webhookCalls[0].url, "http://helix.test/runs/continuation-two/continuations");
    assert.equal((webhookCalls[0].body as { trigger: string }).trigger, "issue.reopened");
    assert.match(
      (webhookCalls[0].body as { externalEventId: string }).externalEventId,
      new RegExp(`^issue-reopened:${issueId}:`),
    );
  });

  it("ordinary comments do not trigger Helix", async () => {
    const created = await request(app)
      .post("/api/projects/default/issues")
      .send({ title: "Just discussing", labels: [] })
      .expect(201);
    webhookCalls.length = 0;

    const comment = await request(app)
      .post(`/api/projects/default/issues/${created.body.issue.id}/comments`)
      .send({ body: "This is only a note" })
      .expect(201);

    assert.equal(comment.body.delivery, null);
    assert.equal(webhookCalls.length, 0);
  });

  it("filters and paginates issue lists", async () => {
    const before = await request(app).get("/api/projects/default/issues?limit=100&offset=0").expect(200);
    const baseTotal = before.body.total as number;

    const createdIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post("/api/projects/default/issues")
        .send({ title: `Paged ${i}`, labels: i === 1 ? ["docs"] : ["bug"] })
        .expect(201);
      createdIds.push(res.body.issue.id);
    }

    await request(app)
      .patch(`/api/projects/default/issues/${createdIds[0]}`)
      .send({ status: "in_progress" })
      .expect(200);

    const byStatus = await request(app).get("/api/projects/default/issues?status=in_progress").expect(200);
    assert.ok(byStatus.body.items.every((issue: { status: string }) => issue.status === "in_progress"));
    assert.ok(byStatus.body.items.some((issue: { id: number }) => issue.id === createdIds[0]));

    const byLabel = await request(app).get("/api/projects/default/issues?label=docs").expect(200);
    assert.ok(byLabel.body.items.every((issue: { labels: string[] }) => issue.labels.includes("docs")));
    assert.ok(byLabel.body.items.some((issue: { id: number }) => issue.id === createdIds[1]));

    const page = await request(app).get("/api/projects/default/issues?limit=2&offset=0").expect(200);
    assert.equal(page.body.limit, 2);
    assert.equal(page.body.offset, 0);
    assert.equal(page.body.items.length, 2);
    assert.equal(page.body.total, baseTotal + 3);

    const next = await request(app).get("/api/projects/default/issues?limit=2&offset=2").expect(200);
    assert.equal(next.body.offset, 2);
    assert.ok(next.body.items.length >= 1);
    assert.notEqual(next.body.items[0].id, page.body.items[0].id);
  });

  it("manages local PR review lifecycle and ignores stale SHA decisions", async () => {
    const issue = await request(app)
      .post("/api/projects/default/issues")
      .send({ title: "Local PR issue", body: "Acceptance criteria", labels: [] })
      .expect(201);
    const issueId = issue.body.issue.id as number;

    const created = await request(app)
      .post("/api/projects/default/pull-requests")
      .send({
        issueId,
        title: "Implement local PR",
        description: "Review this exact change",
        repositoryPath: "/tmp/example-repo",
        baseBranch: "main",
        baseSha: "base-1",
        headBranch: "feature/local-pr",
        headSha: "head-1",
        author: "alice",
        origin: "external",
      })
      .expect(201);
    const pullRequestId = created.body.id as number;
    assert.equal(created.body.status, "draft");

    webhookCalls.length = 0;
    const requested = await request(app)
      .post(`/api/projects/default/pull-requests/${pullRequestId}/review`)
      .expect(202);
    assert.equal(requested.body.delivery.success, true);
    assert.equal(webhookCalls[0].url, "http://helix.test/pr-reviews");
    assert.equal(
      (webhookCalls[0].body as { externalEventId: string }).externalEventId,
      `pull-request:${pullRequestId}:head:head-1`,
    );

    await request(app).post("/api/webhooks/helix").set("X-Helix-Event", "pr.review.started").send({
      event: "pr.review.started",
      review: {
        id: "review-one",
        status: "running",
        headSha: "head-1",
        startedAt: 100,
      },
      pullRequest: { id: pullRequestId },
    }).expect(200);

    await request(app).post("/api/webhooks/helix").set("X-Helix-Event", "pr.review.completed").send({
      event: "pr.review.completed",
      review: {
        id: "review-one",
        status: "completed",
        headSha: "head-1",
        startedAt: 100,
        finishedAt: 200,
        decision: "ready_to_merge",
        summary: "reviewer and verifier passed",
        findings: [],
        checks: [{ name: "npm test", status: "passed", summary: "all passed" }],
      },
      pullRequest: { id: pullRequestId },
    }).expect(200);

    const ready = await request(app).get(`/api/projects/default/pull-requests/${pullRequestId}`).expect(200);
    assert.equal(ready.body.status, "ready_to_merge");
    assert.equal(ready.body.reviews.length, 1);

    const updatedHead = await request(app)
      .patch(`/api/projects/default/pull-requests/${pullRequestId}`)
      .send({ headSha: "head-2" })
      .expect(200);
    assert.equal(updatedHead.body.status, "draft");
    assert.equal(updatedHead.body.activeReviewRunId, undefined);

    const stale = await request(app).post("/api/webhooks/helix").send({
      event: "pr.review.completed",
      review: {
        id: "late-old-review",
        status: "completed",
        headSha: "head-1",
        startedAt: 300,
        finishedAt: 400,
        decision: "ready_to_merge",
        summary: "stale",
      },
      pullRequest: { id: pullRequestId },
    }).expect(200);
    assert.equal(stale.body.stale, true);
    assert.equal(stale.body.pullRequest.status, "draft");

    await request(app).patch(`/api/projects/default/pull-requests/${pullRequestId}`)
      .send({ status: "merged" })
      .expect(409);
  });

  it("keeps linked issue open for PR review and closes only after human merge record", async () => {
    const issue = await request(app)
      .post("/api/projects/default/issues")
      .send({ title: "Human merge boundary", labels: [] })
      .expect(201);
    const issueId = issue.body.issue.id as number;
    const pullRequest = await request(app).post("/api/projects/default/pull-requests").send({
      issueId,
      title: "Ready change",
      repositoryPath: "/tmp/example-repo",
      baseBranch: "main",
      baseSha: "base",
      headBranch: "feature/ready",
      headSha: "head",
      author: "helix",
      origin: "helix",
    }).expect(201);
    const pullRequestId = pullRequest.body.id as number;

    await request(app).post("/api/webhooks/helix").send({
      event: "run.completed",
      run: { id: "implementation-run", status: "done", startedAt: 1, finishedAt: 2 },
      issue: { id: issueId, title: "Human merge boundary" },
    }).expect(200);
    const inProgress = await request(app).get(`/api/projects/default/issues/${issueId}`).expect(200);
    assert.equal(inProgress.body.status, "in_progress");

    await request(app).post("/api/webhooks/helix").send({
      event: "pr.review.completed",
      review: {
        id: "review-ready",
        status: "completed",
        headSha: "head",
        startedAt: 3,
        finishedAt: 4,
        decision: "ready_to_merge",
        summary: "ready",
      },
      pullRequest: { id: pullRequestId },
    }).expect(200);

    await request(app).patch(`/api/projects/default/pull-requests/${pullRequestId}`)
      .send({ status: "merged", mergeCommitSha: "merge-sha" })
      .expect(200);
    const closed = await request(app).get(`/api/projects/default/issues/${issueId}`).expect(200);
    assert.equal(closed.body.status, "closed");
  });

  it("addresses failed PR review by continuing the linked Helix run", async () => {
    const issue = await request(app)
      .post("/api/projects/default/issues")
      .send({ title: "Needs follow-up", labels: [] })
      .expect(201);
    const issueId = issue.body.issue.id as number;
    const pullRequest = await request(app).post("/api/projects/default/pull-requests").send({
      issueId,
      title: "Change with feedback",
      repositoryPath: "/tmp/example-repo",
      baseBranch: "main",
      baseSha: "base",
      headBranch: "feature/feedback",
      headSha: "head-feedback",
      author: "helix",
      origin: "helix",
    }).expect(201);
    const pullRequestId = pullRequest.body.id as number;

    await request(app).post("/api/webhooks/helix").send({
      event: "run.completed",
      run: { id: "impl-run", status: "done", startedAt: 1, finishedAt: 2 },
      issue: { id: issueId, title: "Needs follow-up" },
    }).expect(200);

    await request(app).post("/api/webhooks/helix").send({
      event: "pr.review.completed",
      review: {
        id: "review-cr",
        status: "completed",
        headSha: "head-feedback",
        startedAt: 3,
        finishedAt: 4,
        decision: "changes_requested",
        summary: "Tests are missing for the failure path.",
        findings: [
          {
            severity: "blocking",
            title: "Missing regression coverage",
            details: "Add a failing-path test before merge.",
          },
        ],
        checks: [{ name: "unit", status: "failed", summary: "1 failed" }],
      },
      pullRequest: { id: pullRequestId },
    }).expect(200);

    webhookCalls.length = 0;
    const addressed = await request(app)
      .post(`/api/projects/default/pull-requests/${pullRequestId}/address-feedback`)
      .expect(202);

    assert.equal(addressed.body.parentRunId, "impl-run");
    assert.equal(addressed.body.delivery.success, true);
    assert.equal(addressed.body.activeRun.status, "running");
    assert.equal(addressed.body.activeRun.trigger, "pull_request.address_feedback");
    assert.equal(addressed.body.issue.status, "in_progress");
    assert.equal(webhookCalls.length, 1);
    assert.equal(webhookCalls[0].url, "http://helix.test/runs/impl-run/continuations");
    const body = webhookCalls[0].body as {
      instruction: string;
      externalEventId: string;
      trigger: string;
    };
    assert.equal(body.trigger, "pull_request.address_feedback");
    assert.match(body.externalEventId, new RegExp(`^pr-address-feedback:${pullRequestId}:review:`));
    assert.match(body.instruction, /Missing regression coverage/);
    assert.match(body.instruction, /Tests are missing/);
    assert.equal(addressed.body.comment.source, "system");
    assert.match(addressed.body.comment.body, /Addressing PR/);

    const issueDetail = await request(app).get(`/api/projects/default/issues/${issueId}`).expect(200);
    assert.equal(issueDetail.body.helix.activeRun.runId, addressed.body.activeRun.runId);
    assert.equal(issueDetail.body.helix.activeRun.trigger, "pull_request.address_feedback");

    const prDetail = await request(app).get(`/api/projects/default/pull-requests/${pullRequestId}`).expect(200);
    assert.equal(prDetail.body.helix.activeRun.runId, addressed.body.activeRun.runId);

    const blocked = await request(app)
      .post(`/api/projects/default/pull-requests/${pullRequestId}/address-feedback`)
      .expect(409);
    assert.match(blocked.body.error, /already in progress/);
  });

  it("refuses address-feedback without a linked Helix run or wrong PR status", async () => {
    const issue = await request(app)
      .post("/api/projects/default/issues")
      .send({ title: "No run yet", labels: [] })
      .expect(201);
    const issueId = issue.body.issue.id as number;
    const pullRequest = await request(app).post("/api/projects/default/pull-requests").send({
      issueId,
      title: "Draft only",
      repositoryPath: "/tmp/example-repo",
      baseBranch: "main",
      baseSha: "base",
      headBranch: "feature/draft",
      headSha: "head-draft",
      author: "helix",
      origin: "helix",
    }).expect(201);

    await request(app)
      .post(`/api/projects/default/pull-requests/${pullRequest.body.id}/address-feedback`)
      .expect(409);

    await request(app).post("/api/webhooks/helix").send({
      event: "run.completed",
      run: { id: "impl-draft", status: "done", startedAt: 1, finishedAt: 2 },
      issue: { id: issueId, title: "No run yet" },
    }).expect(200);

    await request(app)
      .post(`/api/projects/default/pull-requests/${pullRequest.body.id}/address-feedback`)
      .expect(409);
  });

  it("merges a ready-to-merge PR into the local base branch", async () => {
    const repo = mkdtempSync(join(tmpdir(), "acme-issues-merge-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "acme@test.local"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Acme Test"], { cwd: repo });
      writeFileSync(join(repo, "file.txt"), "base\n");
      execFileSync("git", ["add", "file.txt"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
      execFileSync("git", ["checkout", "-b", "feature/merge-me"], { cwd: repo });
      writeFileSync(join(repo, "file.txt"), "base\nchange\n");
      execFileSync("git", ["add", "file.txt"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "change"], { cwd: repo });
      const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
      execFileSync("git", ["checkout", "main"], { cwd: repo });

      const issue = await request(app)
        .post("/api/projects/default/issues")
        .send({ title: "Merge locally", labels: [] })
        .expect(201);
      const issueId = issue.body.issue.id as number;
      const created = await request(app).post("/api/projects/default/pull-requests").send({
        issueId,
        title: "Ship local change",
        repositoryPath: repo,
        baseBranch: "main",
        baseSha,
        headBranch: "feature/merge-me",
        headSha,
        author: "helix",
        origin: "helix",
      }).expect(201);
      const pullRequestId = created.body.id as number;

      await request(app).post("/api/webhooks/helix").send({
        event: "pr.review.completed",
        review: {
          id: "review-merge",
          status: "completed",
          headSha,
          startedAt: 1,
          finishedAt: 2,
          decision: "ready_to_merge",
          summary: "ready",
        },
        pullRequest: { id: pullRequestId },
      }).expect(200);

      const detail = await request(app).get(`/api/projects/default/pull-requests/${pullRequestId}`).expect(200);
      assert.equal(detail.body.status, "ready_to_merge");
      assert.match(detail.body.mergeCommands.shell, /git merge --no-ff/);
      assert.equal(detail.body.mergeCommands.lines.length, 3);

      const merged = await request(app)
        .post(`/api/projects/default/pull-requests/${pullRequestId}/merge`)
        .expect(200);
      assert.equal(merged.body.pullRequest.status, "merged");
      assert.equal(typeof merged.body.mergeCommitSha, "string");
      assert.equal(
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
        merged.body.mergeCommitSha,
      );
      assert.match(
        execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: repo, encoding: "utf8" }),
        /Merge local PR/,
      );
      assert.match(
        execFileSync("git", ["show", "HEAD:file.txt"], { cwd: repo, encoding: "utf8" }),
        /change/,
      );

      const closed = await request(app).get(`/api/projects/default/issues/${issueId}`).expect(200);
      assert.equal(closed.body.status, "closed");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("merges via Helix when Issues cannot see the repository path", async () => {
    const issue = await request(app)
      .post("/api/projects/default/issues")
      .send({ title: "Remote merge", labels: [] })
      .expect(201);
    const issueId = issue.body.issue.id as number;
    const created = await request(app).post("/api/projects/default/pull-requests").send({
      issueId,
      title: "Helix-owned change",
      repositoryPath: "/no/such/path/from-webhook",
      baseBranch: "main",
      baseSha: "base",
      headBranch: "feature/helix-merge",
      headSha: "head-helix",
      author: "helix",
      origin: "helix",
    }).expect(201);
    const pullRequestId = created.body.id as number;

    await request(app).post("/api/webhooks/helix").send({
      event: "pr.review.completed",
      review: {
        id: "review-helix-merge",
        status: "completed",
        headSha: "head-helix",
        startedAt: 1,
        finishedAt: 2,
        decision: "ready_to_merge",
        summary: "ready",
      },
      pullRequest: { id: pullRequestId },
    }).expect(200);

    const dispatcher = new WebhookDispatcher({
      db,
      authToken: "svc_helix_test",
      trustedOrigins: ["http://helix.test"],
      fetchFn: async (url, init) => {
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer svc_helix_test");
        const href = String(url);
        if (href.endsWith("/workspace")) {
          return new Response(JSON.stringify({ cwd: "/tmp/helix-workspace" }), { status: 200 });
        }
        if (href.endsWith("/local-prs/merge")) {
          const body = JSON.parse(String(init?.body)) as {
            projectId: number;
            projectSlug: string;
            pullRequest: { id: number; headSha: string };
          };
          assert.equal(body.projectId, created.body.projectId);
          assert.equal(body.projectSlug, "default");
          assert.equal(body.pullRequest.id, pullRequestId);
          assert.equal(body.pullRequest.headSha, "head-helix");
          return new Response(JSON.stringify({
            mergeCommitSha: "merge-from-helix",
            repositoryPath: "/tmp/helix-workspace",
            baseBranch: "main",
            headSha: "head-helix",
          }), { status: 200 });
        }
        return new Response("{}", { status: 404 });
      },
    });
    const helixApp = createApp({ db, dispatcher });

    const detail = await request(helixApp).get(`/api/projects/default/pull-requests/${pullRequestId}`).expect(200);
    assert.match(detail.body.mergeCommands.shell, /\/tmp\/helix-workspace/);

    const merged = await request(helixApp)
      .post(`/api/projects/default/pull-requests/${pullRequestId}/merge`)
      .expect(200);
    assert.equal(merged.body.via, "helix");
    assert.equal(merged.body.mergeCommitSha, "merge-from-helix");
    assert.equal(merged.body.pullRequest.status, "merged");

    const closed = await request(helixApp).get(`/api/projects/default/issues/${issueId}`).expect(200);
    assert.equal(closed.body.status, "closed");
  });

  it("deletes one pull request or clears all PR history", async () => {
    const first = await request(app).post("/api/projects/default/pull-requests").send({
      title: "First",
      repositoryPath: "/tmp/example-repo",
      baseBranch: "main",
      baseSha: "base",
      headBranch: "feature/one",
      headSha: "head-1",
      author: "helix",
      origin: "helix",
    }).expect(201);
    const second = await request(app).post("/api/projects/default/pull-requests").send({
      title: "Second",
      repositoryPath: "/tmp/example-repo",
      baseBranch: "main",
      baseSha: "base",
      headBranch: "feature/two",
      headSha: "head-2",
      author: "helix",
      origin: "helix",
    }).expect(201);

    await request(app).post("/api/webhooks/helix").send({
      event: "pr.review.completed",
      review: {
        id: "review-to-delete",
        status: "completed",
        headSha: "head-1",
        startedAt: 1,
        finishedAt: 2,
        decision: "changes_requested",
        summary: "needs work",
      },
      pullRequest: { id: first.body.id },
    }).expect(200);

    const detail = await request(app).get(`/api/projects/default/pull-requests/${first.body.id}`).expect(200);
    assert.equal(detail.body.reviews.length, 1);

    await request(app).delete(`/api/projects/default/pull-requests/${first.body.id}`).expect(204);
    await request(app).get(`/api/projects/default/pull-requests/${first.body.id}`).expect(404);
    await request(app).delete(`/api/projects/default/pull-requests/${first.body.id}`).expect(404);

    const remaining = await request(app).get("/api/projects/default/pull-requests").expect(200);
    assert.equal(remaining.body.some((item: { id: number }) => item.id === second.body.id), true);

    const cleared = await request(app).delete("/api/projects/default/pull-requests").expect(200);
    assert.ok(cleared.body.deleted >= 1);
    const empty = await request(app).get("/api/projects/default/pull-requests").expect(200);
    assert.equal(empty.body.length, 0);
  });

  it("serves the React interface", async () => {
    const page = await request(app).get("/").expect(200);
    assert.match(page.text, /id="root"/);

    await request(app).get("/legacy").expect(404);
    await request(app).get("/app.js").expect(404);
    await request(app).get("/api/repositories/browse").expect(404);

    const reactPreview = await request(app).get("/react").expect(302);
    assert.equal(reactPreview.headers.location, "/");
  });
});
