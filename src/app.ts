import express, { type Express, type Request, type Response } from "express";
import type Database from "better-sqlite3";
import { attachHmr, webAssets, webFromSource, webIndex } from "./webAssets.js";
import {
  clearDeliveries,
  createIssue,
  deleteDelivery,
  deleteIssue,
  getIssue,
  getIssueById,
  issueMatchesFilter,
  labelWasAdded,
  listDeliveries,
  listIssues,
  updateIssue,
} from "./issues.js";
import type { IssueStatus, Project, ProjectUpdate } from "./types.js";
import {
  addHelixCompletionComment,
  addHelixPullRequestComment,
  addHelixStartComment,
  createComment,
  deleteComment,
  getComment,
  listComments,
  updateComment,
} from "./comments.js";
import type { HelixRunPayload } from "./types.js";
import type {
  HelixPullRequestReviewPayload,
  PullRequestOrigin,
  PullRequestStatus,
} from "./types.js";
import { WebhookDispatcher } from "./webhooks.js";
import { notifyProjectsLifecycle } from "./projectsLifecycle.js";
import { buildAddressFeedbackInstruction } from "./addressFeedback.js";
import type { Issue } from "./types.js";
import {
  activeHelixRun,
  helixActivityForIssue,
  latestCompletedHelixRun,
  parseHelixContinuationResponse,
  recordHelixRun,
  recordPendingHelixRun,
} from "./helixRuns.js";
import {
  createPullRequest,
  clearPullRequests,
  deletePullRequest,
  getPullRequestInProject,
  hasUnmergedPullRequest,
  listPullRequestReviews,
  listPullRequests,
  recordPullRequestReview,
  updatePullRequest,
} from "./pullRequests.js";
import { readPullRequestDiff } from "./pullRequestDiff.js";
import {
  buildMergeCommandSnippet,
  isGitWorkingTree,
  mergePullRequestLocally,
} from "./mergePullRequest.js";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  projectSettings,
  updateProject,
} from "./projects.js";

export interface CreateAppOptions {
  db: Database.Database;
  dispatcher?: WebhookDispatcher;
  fetchFn?: typeof fetch;
}

export function createApp(opts: CreateAppOptions): Express {
  const { db } = opts;
  const fetchFn = opts.fetchFn ?? fetch;
  const dispatcher = opts.dispatcher ?? new WebhookDispatcher({ db, fetchFn });
  const app = express();

  const emitProjects = async (
    issue: Issue | null | undefined,
    project: Project,
    event: Parameters<typeof notifyProjectsLifecycle>[2],
    externalEventId: string,
    pullRequestId?: number,
  ) => {
    if (!issue?.projectsCallbackUrl || !issue.sourceCardId) return;
    await notifyProjectsLifecycle(issue, project, event, {
      fetchFn,
      externalEventId,
      pullRequestId,
    });
  };

  app.use(express.json());
  app.use(webAssets());
  app.get(["/react", "/react/"], (_req, res) => res.redirect("/"));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/projects", (_req, res) => {
    res.json(listProjects(db));
  });

  app.post("/api/projects", (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (typeof body.title !== "string" || !body.title.trim()) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    try {
      const project = createProject(db, {
        title: body.title,
        slug: typeof body.slug === "string" ? body.slug : undefined,
        webhookUrl: typeof body.webhookUrl === "string" ? body.webhookUrl : undefined,
        labelFilter: typeof body.labelFilter === "string" ? body.labelFilter : undefined,
        commentTrigger: typeof body.commentTrigger === "string" ? body.commentTrigger : undefined,
        webhookEnabled: typeof body.webhookEnabled === "boolean" ? body.webhookEnabled : undefined,
        baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
      });
      res.status(201).json(project);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/projects/:projectRef", (req, res) => {
    const project = getProject(db, projectRefParam(req));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(project);
  });

  app.patch("/api/projects/:projectRef", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const patch: ProjectUpdate = {};
    if (typeof body.title === "string") patch.title = body.title;
    if (typeof body.slug === "string") patch.slug = body.slug;
    if (typeof body.webhookUrl === "string") patch.webhookUrl = body.webhookUrl.trim();
    if (typeof body.labelFilter === "string") patch.labelFilter = body.labelFilter.trim();
    if (typeof body.commentTrigger === "string" && body.commentTrigger.trim()) {
      patch.commentTrigger = body.commentTrigger.trim();
    }
    if (typeof body.webhookEnabled === "boolean") patch.webhookEnabled = body.webhookEnabled;
    if (typeof body.baseUrl === "string") patch.baseUrl = body.baseUrl.trim();
    try {
      const project = updateProject(db, projectRefParam(req), patch);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      res.json(project);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/api/projects/:projectRef", (req, res) => {
    if (!deleteProject(db, projectRefParam(req))) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.status(204).end();
  });

  app.get("/api/projects/:projectRef/issues", (req, res) => {
    const project = requireProject(db, req, res);
    if (!project) return;
    const status = parseStatus(req.query.status);
    const label =
      typeof req.query.label === "string" && req.query.label.trim()
        ? req.query.label.trim()
        : undefined;
    const limit = Number(req.query.limit);
    const offset = Number(req.query.offset);
    res.json(
      listIssues(db, project, {
        status,
        label,
        limit: Number.isFinite(limit) ? limit : undefined,
        offset: Number.isFinite(offset) ? offset : undefined,
      }),
    );
  });

  app.get("/api/projects/:projectRef/issues/:id", (req, res) => {
    const project = requireProject(db, req, res);
    if (!project) return;
    const id = Number(req.params.id);
    const issue = getIssue(db, project, id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    res.json({ ...issue, helix: helixActivityForIssue(db, id) });
  });

  app.get("/api/projects/:projectRef/issues/:id/comments", (req, res) => {
    const project = requireProject(db, req, res);
    if (!project) return;
    const id = Number(req.params.id);
    const issue = getIssue(db, project, id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    res.json(listComments(db, id));
  });

  app.post("/api/projects/:projectRef/issues/:id/comments", async (req, res) => {
    const project = requireProject(db, req, res);
    if (!project) return;
    const config = projectSettings(project);
    const id = Number(req.params.id);
    const issue = getIssue(db, project, id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const body = req.body as Record<string, unknown>;
    if (typeof body.body !== "string" || !body.body.trim()) {
      res.status(400).json({ error: "body is required" });
      return;
    }

    const instruction = continuationInstruction(body.body, config.commentTrigger);
    if (instruction && config.webhookEnabled && activeHelixRun(db, id)) {
      res.status(409).json({ error: "A Helix run is already in progress for this issue" });
      return;
    }

    const comment = createComment(db, id, {
      body: body.body,
      author: typeof body.author === "string" ? body.author : "user",
      source: "user",
    });

    let delivery = null;
    let currentIssue = issue;
    if (instruction && config.webhookEnabled) {
      const parent = latestCompletedHelixRun(db, id);
      if (parent) {
        if (currentIssue.status === "closed") {
          currentIssue = updateIssue(db, project, id, { status: "open" }) ?? currentIssue;
        }
        delivery = await dispatcher.dispatchContinuation(
          currentIssue,
          parent.runId,
          {
            instruction,
            externalEventId: `comment:${comment.id}`,
            trigger: "issue.comment",
          },
          "issue.comment",
        );
        if (delivery?.success) {
          const accepted = parseHelixContinuationResponse(delivery.responseBody);
          if (accepted.runId) {
            recordPendingHelixRun(db, {
              issueId: currentIssue.id,
              runId: accepted.runId,
              parentRunId: parent.runId,
              rootRunId: parent.rootRunId,
              trigger: "issue.comment",
            });
          }
          if (currentIssue.status !== "in_progress") {
            currentIssue =
              updateIssue(db, project, currentIssue.id, { status: "in_progress" }) ?? currentIssue;
            await emitProjects(
              currentIssue,
              project,
              "implementation.started",
              `issue:${currentIssue.id}:comment:${comment.id}:continuation`,
            );
          }
        }
      }
    }
    res.status(201).json({ ...comment, delivery, issue: currentIssue });
  });

  app.patch("/api/projects/:projectRef/issues/:issueId/comments/:commentId", (req, res) => {
    const project = requireProject(db, req, res);
    if (!project) return;
    const issueId = Number(req.params.issueId);
    const commentId = Number(req.params.commentId);
    const issue = getIssue(db, project, issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const existing = getComment(db, commentId);
    if (!existing || existing.issueId !== issueId) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const patch: Parameters<typeof updateComment>[2] = {};
    if (typeof body.body === "string") {
      if (!body.body.trim()) {
        res.status(400).json({ error: "body cannot be empty" });
        return;
      }
      patch.body = body.body;
    }
    if (typeof body.author === "string") patch.author = body.author;

    if (patch.body === undefined && patch.author === undefined) {
      res.status(400).json({ error: "no fields to update" });
      return;
    }

    const comment = updateComment(db, commentId, patch);
    if (!comment) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    res.json(comment);
  });

  app.delete("/api/projects/:projectRef/issues/:issueId/comments/:commentId", (req, res) => {
    const project = requireProject(db, req, res);
    if (!project) return;
    const issueId = Number(req.params.issueId);
    const commentId = Number(req.params.commentId);
    const issue = getIssue(db, project, issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const existing = getComment(db, commentId);
    if (!existing || existing.issueId !== issueId) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }

    if (!deleteComment(db, commentId)) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    res.status(204).end();
  });

  app.post("/api/projects/:projectRef/issues", async (req, res) => {
    const project = requireProject(db, req, res);
    if (!project) return;
    const config = projectSettings(project);
    const body = req.body as Record<string, unknown>;
    if (typeof body.title !== "string" || !body.title.trim()) {
      res.status(400).json({ error: "title is required" });
      return;
    }

    const issue = createIssue(db, project, {
      title: body.title,
      body: typeof body.body === "string" ? body.body : "",
      labels: parseLabels(body.labels),
      status: parseStatus(body.status) ?? "open",
      sourceCardId: typeof body.sourceCardId === "string" ? body.sourceCardId : undefined,
      projectsCallbackUrl:
        typeof body.projectsCallbackUrl === "string" ? body.projectsCallbackUrl : undefined,
    });

    let delivery = null;
    if (dispatcher.shouldAutoTrigger(issue, config)) {
      delivery = await dispatcher.dispatchForIssue(issue, "issue.created");
    }

    res.status(201).json({ issue, delivery });
  });

  app.patch("/api/projects/:projectRef/issues/:id", async (req, res) => {
    const project = requireProject(db, req, res);
    if (!project) return;
    const config = projectSettings(project);
    const id = Number(req.params.id);
    const existing = getIssue(db, project, id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const patch: Parameters<typeof updateIssue>[3] = {};
    if (typeof body.title === "string") patch.title = body.title;
    if (typeof body.body === "string") patch.body = body.body;
    const status = parseStatus(body.status);
    if (status) patch.status = status;
    if (body.labels !== undefined) patch.labels = parseLabels(body.labels);

    const issue = updateIssue(db, project, id, patch);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    if (existing.status !== issue.status) {
      if (issue.status === "in_progress") {
        await emitProjects(
          issue,
          project,
          "implementation.started",
          `issue:${issue.id}:status:in_progress:${issue.updatedAt}`,
        );
      } else if (issue.status === "closed") {
        await emitProjects(
          issue,
          project,
          "implementation.completed",
          `issue:${issue.id}:status:closed:${issue.updatedAt}`,
        );
      }
    }

    let delivery = null;
    const labelAdded =
      patch.labels !== undefined &&
      labelWasAdded(existing.labels, issue.labels, config.labelFilter);
    const reopened = existing.status === "closed" && issue.status === "open";

    if (
      config.webhookEnabled &&
      issueMatchesFilter(issue, config.labelFilter) &&
      (labelAdded || reopened)
    ) {
      if (reopened) {
        const parent = latestCompletedHelixRun(db, issue.id);
        delivery = parent
          ? await dispatcher.dispatchContinuation(
              issue,
              parent.runId,
              {
                instruction:
                  "Issue reopened. Re-evaluate the original issue and address any remaining work.",
                externalEventId: `issue-reopened:${issue.id}:${issue.updatedAt}`,
                trigger: "issue.reopened",
              },
              "issue.reopened",
            )
          : await dispatcher.dispatchForIssue(issue, "issue.reopened");
      } else {
        delivery = await dispatcher.dispatchForIssue(issue, "issue.label_added");
      }
    }

    res.json({ issue, delivery });
  });

  app.delete("/api/projects/:projectRef/issues/:id", (req, res) => {
    const project = requireProject(db, req, res);
    if (!project) return;
    const id = Number(req.params.id);
    if (!deleteIssue(db, project.id, id)) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    res.status(204).end();
  });

  app.post("/api/projects/:projectRef/issues/:id/trigger", async (req, res) => {
    const project = requireProject(db, req, res);
    if (!project) return;
    const id = Number(req.params.id);
    const issue = getIssue(db, project, id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const delivery = await dispatcher.dispatchForIssue(issue, "manual");
    res.json({ issue, delivery });
  });

  app.get("/api/projects/:projectRef/pull-requests", (req, res) => {
    const project = requireProject(db, req, res);
    if (!project) return;
    const status = parsePullRequestStatus(req.query.status);
    res.json(listPullRequests(db, project.id, status));
  });

  app.delete("/api/projects/:projectRef/pull-requests", (req, res) => {
    const project = requireProject(db, req, res);
    if (!project) return;
    const deleted = clearPullRequests(db, project.id);
    res.json({ deleted });
  });

  app.post("/api/projects/:projectRef/pull-requests", async (req, res) => {
    const project = requireProject(db, req, res);
    if (!project) return;
    const body = req.body as Record<string, unknown>;
    const required = [
      "title",
      "repositoryPath",
      "baseBranch",
      "baseSha",
      "headBranch",
      "headSha",
    ] as const;
    for (const field of required) {
      if (typeof body[field] !== "string" || !body[field].trim()) {
        res.status(400).json({ error: `${field} is required` });
        return;
      }
    }
    const issueId = optionalPositiveInteger(body.issueId);
    if (body.issueId !== undefined && !issueId) {
      res.status(400).json({ error: "issueId must be a positive integer" });
      return;
    }
    if (issueId && !getIssue(db, project, issueId)) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    const origin = parsePullRequestOrigin(body.origin);
    if (body.origin !== undefined && !origin) {
      res.status(400).json({ error: "origin must be helix or external" });
      return;
    }
    const pullRequest = createPullRequest(db, {
      projectId: project.id,
      issueId,
      title: String(body.title),
      description: typeof body.description === "string" ? body.description : "",
      repositoryPath: String(body.repositoryPath),
      baseBranch: String(body.baseBranch),
      baseSha: String(body.baseSha),
      headBranch: String(body.headBranch),
      headSha: String(body.headSha),
      author: typeof body.author === "string" ? body.author : "unknown",
      origin,
    });
    if (pullRequest.issueId) {
      const linked = getIssue(db, project, pullRequest.issueId);
      await emitProjects(
        linked,
        project,
        "implementation.in_review",
        `issue:${pullRequest.issueId}:pr:${pullRequest.id}:registered`,
        pullRequest.id,
      );
    }
    res.status(201).json(pullRequest);
  });

  app.get("/api/projects/:projectRef/pull-requests/:id", async (req, res) => {
    const project = requireProject(db, req, res);
    if (!project) return;
    const id = Number(req.params.id);
    const pullRequest = getPullRequestInProject(db, project.id, id);
    if (!pullRequest) {
      res.status(404).json({ error: "Pull request not found" });
      return;
    }
    const helix = pullRequest.issueId ? helixActivityForIssue(db, pullRequest.issueId) : undefined;
    let mergeCommands = undefined;
    if (pullRequest.status === "ready_to_merge") {
      const helixCwd = await dispatcher.fetchHelixWorkspaceCwd(project);
      const commandPath =
        (await isGitWorkingTree(pullRequest.repositoryPath))
          ? pullRequest.repositoryPath
          : helixCwd && (await isGitWorkingTree(helixCwd))
            ? helixCwd
            : helixCwd || pullRequest.repositoryPath;
      mergeCommands = buildMergeCommandSnippet(pullRequest, commandPath);
    }
    res.json({
      ...pullRequest,
      reviews: listPullRequestReviews(db, pullRequest.id),
      helix,
      mergeCommands,
    });
  });

  app.delete("/api/projects/:projectRef/pull-requests/:id", (req, res) => {
    const project = requireProject(db, req, res);
    if (!project) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0 || !deletePullRequest(db, project.id, id)) {
      res.status(404).json({ error: "Pull request not found" });
      return;
    }
    res.status(204).end();
  });

  app.get("/api/projects/:projectRef/pull-requests/:id/diff", async (req, res) => {
    const project = requireProject(db, req, res);
    if (!project) return;
    const pullRequest = getPullRequestInProject(db, project.id, Number(req.params.id));
    if (!pullRequest) {
      res.status(404).json({ error: "Pull request not found" });
      return;
    }
    try {
      res.json(await readPullRequestDiff(pullRequest));
    } catch (err) {
      res.status(422).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/api/projects/:projectRef/pull-requests/:id/merge", async (req, res) => {
    const project = requireProject(db, req, res);
    if (!project) return;
    const id = Number(req.params.id);
    const existing = getPullRequestInProject(db, project.id, id);
    if (!existing) {
      res.status(404).json({ error: "Pull request not found" });
      return;
    }
    if (existing.status !== "ready_to_merge") {
      res.status(409).json({ error: "Only a ready-to-merge pull request can be merged" });
      return;
    }

    const helixCwd = await dispatcher.fetchHelixWorkspaceCwd(project);
    const commandPath =
      (await isGitWorkingTree(existing.repositoryPath))
        ? existing.repositoryPath
        : helixCwd && (await isGitWorkingTree(helixCwd))
          ? helixCwd
          : helixCwd || existing.repositoryPath;
    const mergeCommands = buildMergeCommandSnippet(existing, commandPath);

    const helixMerge = await dispatcher.dispatchLocalPullRequestMerge(existing);
    if (helixMerge.success && helixMerge.mergeCommitSha) {
      const pullRequest = updatePullRequest(db, id, {
        status: "merged",
        mergeCommitSha: helixMerge.mergeCommitSha,
      });
      if (pullRequest?.issueId) {
        const closed = updateIssue(db, project, pullRequest.issueId, { status: "closed" });
        await emitProjects(
          closed,
          project,
          "implementation.completed",
          `issue:${pullRequest.issueId}:pr:${id}:merged`,
          id,
        );
      }
      res.json({
        pullRequest,
        mergeCommitSha: helixMerge.mergeCommitSha,
        baseBranch: existing.baseBranch,
        headSha: existing.headSha,
        via: "helix",
      });
      return;
    }

    if (await isGitWorkingTree(existing.repositoryPath)) {
      try {
        const result = await mergePullRequestLocally(existing);
        const pullRequest = updatePullRequest(db, id, {
          status: "merged",
          mergeCommitSha: result.mergeCommitSha,
        });
        if (pullRequest?.issueId) {
          const closed = updateIssue(db, project, pullRequest.issueId, { status: "closed" });
          await emitProjects(
            closed,
            project,
            "implementation.completed",
            `issue:${pullRequest.issueId}:pr:${id}:merged`,
            id,
          );
        }
        res.json({
          pullRequest,
          mergeCommitSha: result.mergeCommitSha,
          baseBranch: result.baseBranch,
          headSha: result.headSha,
          via: "local",
        });
        return;
      } catch (err) {
        res.status(422).json({
          error: err instanceof Error ? err.message : String(err),
          mergeCommands,
        });
        return;
      }
    }

    res.status(422).json({
      error:
        helixMerge.error ??
        "Could not merge from Acme Issues. Helix is unavailable and the recorded repository path is not accessible — use the copyable git commands.",
      mergeCommands,
    });
  });

  app.patch("/api/projects/:projectRef/pull-requests/:id", async (req, res) => {
    const project = requireProject(db, req, res);
    if (!project) return;
    const id = Number(req.params.id);
    const existing = getPullRequestInProject(db, project.id, id);
    if (!existing) {
      res.status(404).json({ error: "Pull request not found" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const status = body.status === undefined ? undefined : parseMutablePullRequestStatus(body.status);
    if (body.status !== undefined && !status) {
      res.status(400).json({ error: "status can only be draft, merged, or closed" });
      return;
    }
    if (status === "merged" && existing.status !== "ready_to_merge") {
      res.status(409).json({ error: "Only a ready-to-merge pull request can be marked merged" });
      return;
    }
    const pullRequest = updatePullRequest(db, id, {
      title: typeof body.title === "string" ? body.title : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      baseBranch: typeof body.baseBranch === "string" ? body.baseBranch : undefined,
      baseSha: typeof body.baseSha === "string" ? body.baseSha : undefined,
      headBranch: typeof body.headBranch === "string" ? body.headBranch : undefined,
      headSha: typeof body.headSha === "string" ? body.headSha : undefined,
      author: typeof body.author === "string" ? body.author : undefined,
      status,
      mergeCommitSha: typeof body.mergeCommitSha === "string" ? body.mergeCommitSha : undefined,
    });
    if (pullRequest?.status === "merged" && pullRequest.issueId) {
      const closed = updateIssue(db, project, pullRequest.issueId, { status: "closed" });
      await emitProjects(
        closed,
        project,
        "implementation.completed",
        `issue:${pullRequest.issueId}:pr:${id}:merged`,
        id,
      );
    }
    res.json(pullRequest);
  });

  app.post("/api/projects/:projectRef/pull-requests/:id/review", async (req, res) => {
    const project = requireProject(db, req, res);
    if (!project) return;
    const id = Number(req.params.id);
    const pullRequest = getPullRequestInProject(db, project.id, id);
    if (!pullRequest) {
      res.status(404).json({ error: "Pull request not found" });
      return;
    }
    if (pullRequest.status === "merged" || pullRequest.status === "closed") {
      res.status(409).json({ error: `Pull request is ${pullRequest.status}` });
      return;
    }
    const delivery = await dispatcher.dispatchPullRequestReview(pullRequest);
    res.status(delivery.success ? 202 : 502).json({ pullRequest, delivery });
  });

  app.post(
    "/api/projects/:projectRef/pull-requests/:id/address-feedback",
    async (req, res) => {
      const project = requireProject(db, req, res);
      if (!project) return;
      const config = projectSettings(project);
      const id = Number(req.params.id);
      const pullRequest = getPullRequestInProject(db, project.id, id);
      if (!pullRequest) {
        res.status(404).json({ error: "Pull request not found" });
        return;
      }
      if (pullRequest.status !== "changes_requested" && pullRequest.status !== "blocked") {
        res.status(409).json({
          error:
            "Address feedback is only available when review requested changes or blocked the PR",
        });
        return;
      }
      if (!pullRequest.issueId) {
        res.status(409).json({ error: "This pull request has no linked issue to continue" });
        return;
      }
      if (!config.webhookEnabled) {
        res.status(409).json({ error: "Webhooks are disabled" });
        return;
      }

      const active = activeHelixRun(db, pullRequest.issueId);
      if (active) {
        res.status(409).json({
          error: "A Helix run is already in progress for the linked issue",
          activeRun: active,
        });
        return;
      }

      const reviews = listPullRequestReviews(db, pullRequest.id);
      const latest = reviews.find(
        (item) =>
          item.headSha === pullRequest.headSha &&
          item.status === "completed" &&
          (item.decision === "changes_requested" || item.decision === "blocked"),
      );
      if (!latest) {
        res.status(409).json({
          error: "No completed failing review found for the current head SHA",
        });
        return;
      }

      const parent = latestCompletedHelixRun(db, pullRequest.issueId);
      if (!parent) {
        res.status(409).json({
          error: "No completed Helix implementation run is recorded for the linked issue",
        });
        return;
      }

      let issue = getIssue(db, project, pullRequest.issueId);
      if (!issue) {
        res.status(409).json({ error: "Linked issue was not found" });
        return;
      }
      if (issue.status === "closed") {
        issue = updateIssue(db, project, issue.id, { status: "open" }) ?? issue;
      }

      const instruction = buildAddressFeedbackInstruction(pullRequest, latest);
      const comment = createComment(db, issue.id, {
        body: [
          `Addressing PR #${pullRequest.id} review feedback (${latest.decision}).`,
          `Continuing Helix run ${parent.runId}.`,
          "",
          instruction,
        ].join("\n"),
        author: "acme-issues",
        source: "system",
      });

      const delivery = await dispatcher.dispatchContinuation(
        issue,
        parent.runId,
        {
          instruction,
          externalEventId: `pr-address-feedback:${pullRequest.id}:review:${latest.id}`,
          trigger: "pull_request.address_feedback",
          pullRequestId: pullRequest.id,
          pullRequestHeadBranch: pullRequest.headBranch,
        },
        "pull_request.address_feedback",
      );

      let activeRun = undefined;
      if (delivery?.success) {
        const accepted = parseHelixContinuationResponse(delivery.responseBody);
        if (accepted.runId) {
          activeRun = recordPendingHelixRun(db, {
            issueId: issue.id,
            runId: accepted.runId,
            parentRunId: parent.runId,
            rootRunId: parent.rootRunId,
            trigger: "pull_request.address_feedback",
          });
        }
        if (issue.status !== "in_progress") {
          issue = updateIssue(db, project, issue.id, { status: "in_progress" }) ?? issue;
          await emitProjects(
            issue,
            project,
            "implementation.started",
            `issue:${issue.id}:pr:${pullRequest.id}:address_feedback`,
            pullRequest.id,
          );
        }
      }

      res.status(delivery?.success ? 202 : 502).json({
        pullRequest,
        issue,
        comment,
        parentRunId: parent.runId,
        activeRun,
        delivery,
      });
    },
  );

  app.get("/api/projects/:projectRef/webhooks/deliveries", (req, res) => {
    const project = requireProject(db, req, res);
    if (!project) return;
    const limit = Number(req.query.limit ?? 50);
    res.json(listDeliveries(db, project.id, Number.isFinite(limit) ? limit : 50));
  });

  app.delete("/api/projects/:projectRef/webhooks/deliveries/:id", (req, res) => {
    const project = requireProject(db, req, res);
    if (!project) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0 || !deleteDelivery(db, project.id, id)) {
      res.status(404).json({ error: "Delivery not found" });
      return;
    }
    res.status(204).end();
  });

  app.delete("/api/projects/:projectRef/webhooks/deliveries", (req, res) => {
    const project = requireProject(db, req, res);
    if (!project) return;
    const deleted = clearDeliveries(db, project.id);
    res.json({ deleted });
  });

  app.post("/api/webhooks/helix", async (req, res) => {
    const event =
      (typeof req.headers["x-helix-event"] === "string" ? req.headers["x-helix-event"] : undefined) ??
      (typeof req.body?.event === "string" ? req.body.event : undefined);

    if (event === "pr.review.started" || event === "pr.review.completed") {
      const payload = req.body as HelixPullRequestReviewPayload;
      const recorded = recordPullRequestReview(db, payload);
      if (!recorded) {
        res.status(404).json({ error: "Pull request not found or invalid review payload" });
        return;
      }
      res.status(200).json({ ok: true, ...recorded });
      return;
    }

    if (event !== "run.started" && event !== "run.completed") {
      res.status(200).json({ ok: true, ignored: true, event: event ?? null });
      return;
    }

    const issueId = Number(req.body?.issue?.id);
    if (!Number.isInteger(issueId) || issueId <= 0) {
      res.status(400).json({ error: "issue.id is required" });
      return;
    }

    const resolved = getIssueById(db, issueId);
    if (!resolved) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    const { project } = resolved;
    let existing = resolved.issue;

    const payload = req.body as HelixRunPayload;
    recordHelixRun(db, issueId, payload);

    if (event === "run.started") {
      if (existing.status === "closed") {
        res.status(200).json({ ok: true, issue: existing, ignored: true, reason: "already_closed" });
        return;
      }
      if (existing.status === "in_progress") {
        res.status(200).json({ ok: true, issue: existing, alreadyInProgress: true });
        return;
      }
      const issue = updateIssue(db, project, issueId, { status: "in_progress" });
      const comment = addHelixStartComment(db, issueId, payload);
      await emitProjects(
        issue,
        project,
        "implementation.started",
        `issue:${issueId}:run:${payload.run.id}:started`,
      );
      res.status(200).json({ ok: true, issue, comment });
      return;
    }

    if (existing.status === "closed") {
      res.status(200).json({ ok: true, issue: existing, alreadyClosed: true });
      return;
    }

    if (hasUnmergedPullRequest(db, issueId)) {
      const issue =
        existing.status === "in_progress"
          ? existing
          : updateIssue(db, project, issueId, { status: "in_progress" });
      if (existing.status !== "in_progress") {
        await emitProjects(
          issue,
          project,
          "implementation.started",
          `issue:${issueId}:run:${payload.run.id}:awaiting_pr`,
        );
      }
      const comment = addHelixPullRequestComment(db, issueId, payload);
      res.status(200).json({ ok: true, issue, comment, awaitingPullRequest: true });
      return;
    }

    const issue = updateIssue(db, project, issueId, { status: "closed" });
    const comment = addHelixCompletionComment(db, issueId, payload);
    await emitProjects(
      issue,
      project,
      "implementation.completed",
      `issue:${issueId}:run:${payload.run.id}:completed`,
    );
    res.status(200).json({ ok: true, issue, comment });
  });

  app.get("/", webIndex());

  return app;
}

export function startServer(opts: CreateAppOptions & { port: number; host?: string }): void {
  const host = opts.host ?? "127.0.0.1";
  const baseUrl = `http://${host}:${opts.port}`;

  const app = createApp(opts);
  const server = app.listen(opts.port, host, () => {
    console.log(`Acme Issues  ${baseUrl}${webFromSource() ? "  (web from source)" : ""}`);
  });
  attachHmr(server);
}

function projectRefParam(req: Request): string {
  const raw = req.params.projectRef;
  return Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
}

function requireProject(
  db: Database.Database,
  req: Request,
  res: Response,
): Project | null {
  const project = getProject(db, projectRefParam(req));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return null;
  }
  return project;
}

function parseStatus(value: unknown): IssueStatus | undefined {
  if (value === "open" || value === "in_progress" || value === "closed") return value;
  return undefined;
}

function parseLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((l): l is string => typeof l === "string");
}

function parsePullRequestStatus(value: unknown): PullRequestStatus | undefined {
  return value === "draft" ||
    value === "reviewing" ||
    value === "changes_requested" ||
    value === "blocked" ||
    value === "ready_to_merge" ||
    value === "merged" ||
    value === "closed"
    ? value
    : undefined;
}

function parseMutablePullRequestStatus(value: unknown): "draft" | "merged" | "closed" | undefined {
  return value === "draft" || value === "merged" || value === "closed" ? value : undefined;
}

function parsePullRequestOrigin(value: unknown): PullRequestOrigin | undefined {
  return value === "helix" || value === "external" ? value : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function continuationInstruction(commentBody: string, command: string): string | undefined {
  const body = commentBody.trim();
  const trigger = command.trim();
  if (!trigger) return undefined;
  if (body === trigger) return undefined;
  if (!body.startsWith(`${trigger} `) && !body.startsWith(`${trigger}\n`)) return undefined;
  const instruction = body.slice(trigger.length).trim();
  return instruction || undefined;
}
