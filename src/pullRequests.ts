import type Database from "better-sqlite3";
import type {
  HelixPullRequestReviewPayload,
  PullRequest,
  PullRequestDecision,
  PullRequestOrigin,
  PullRequestReview,
  PullRequestReviewCheck,
  PullRequestReviewFinding,
  PullRequestStatus,
} from "./types.js";

interface PullRequestRow {
  id: number;
  project_id: number;
  issue_id: number | null;
  title: string;
  description: string;
  repository_path: string;
  base_branch: string;
  base_sha: string;
  head_branch: string;
  head_sha: string;
  author: string;
  origin: PullRequestOrigin;
  status: PullRequestStatus;
  active_review_run_id: string | null;
  created_at: number;
  updated_at: number;
  merged_at: number | null;
  merge_commit_sha: string | null;
}

interface PullRequestReviewRow {
  id: number;
  pull_request_id: number;
  review_run_id: string;
  head_sha: string;
  status: PullRequestReview["status"];
  decision: PullRequestDecision | null;
  summary: string;
  findings_json: string;
  checks_json: string;
  started_at: number;
  finished_at: number | null;
}

export interface CreatePullRequestInput {
  projectId: number;
  issueId?: number;
  title: string;
  description?: string;
  repositoryPath: string;
  baseBranch: string;
  baseSha: string;
  headBranch: string;
  headSha: string;
  author?: string;
  origin?: PullRequestOrigin;
}

export interface UpdatePullRequestInput {
  title?: string;
  description?: string;
  baseBranch?: string;
  baseSha?: string;
  headBranch?: string;
  headSha?: string;
  author?: string;
  status?: "merged" | "closed" | "draft";
  mergeCommitSha?: string;
}

export function createPullRequest(
  db: Database.Database,
  input: CreatePullRequestInput,
): PullRequest {
  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO pull_requests (
      project_id, issue_id, title, description, repository_path, base_branch, base_sha,
      head_branch, head_sha, author, origin, status, created_at, updated_at
    ) VALUES (
      @projectId, @issueId, @title, @description, @repositoryPath, @baseBranch, @baseSha,
      @headBranch, @headSha, @author, @origin, 'draft', @now, @now
    )
  `).run({
    projectId: input.projectId,
    issueId: input.issueId ?? null,
    title: input.title.trim(),
    description: input.description?.trim() ?? "",
    repositoryPath: input.repositoryPath.trim(),
    baseBranch: input.baseBranch.trim(),
    baseSha: input.baseSha.trim(),
    headBranch: input.headBranch.trim(),
    headSha: input.headSha.trim(),
    author: input.author?.trim() || "unknown",
    origin: input.origin ?? "external",
    now,
  });
  return getPullRequest(db, Number(result.lastInsertRowid))!;
}

export function getPullRequest(db: Database.Database, id: number): PullRequest | undefined {
  const row = db.prepare("SELECT * FROM pull_requests WHERE id = ?").get(id) as PullRequestRow | undefined;
  return row ? toPullRequest(row) : undefined;
}

export function getPullRequestInProject(
  db: Database.Database,
  projectId: number,
  id: number,
): PullRequest | undefined {
  const row = db
    .prepare("SELECT * FROM pull_requests WHERE id = ? AND project_id = ?")
    .get(id, projectId) as PullRequestRow | undefined;
  return row ? toPullRequest(row) : undefined;
}

export function listPullRequests(
  db: Database.Database,
  projectId: number,
  status?: PullRequestStatus,
): PullRequest[] {
  const rows = status
    ? db
        .prepare(
          "SELECT * FROM pull_requests WHERE project_id = ? AND status = ? ORDER BY updated_at DESC",
        )
        .all(projectId, status)
    : db
        .prepare("SELECT * FROM pull_requests WHERE project_id = ? ORDER BY updated_at DESC")
        .all(projectId);
  return (rows as PullRequestRow[]).map(toPullRequest);
}

export function deletePullRequest(
  db: Database.Database,
  projectId: number,
  id: number,
): boolean {
  return db
    .prepare("DELETE FROM pull_requests WHERE id = ? AND project_id = ?")
    .run(id, projectId).changes > 0;
}

/** Removes all local PRs for a project and their review rows (FK CASCADE). */
export function clearPullRequests(db: Database.Database, projectId: number): number {
  return db.prepare("DELETE FROM pull_requests WHERE project_id = ?").run(projectId).changes;
}

export function hasUnmergedPullRequest(
  db: Database.Database,
  issueId: number,
): boolean {
  return Boolean(getOpenPullRequestForIssue(db, issueId));
}

/** Newest unmerged local PR linked to an issue, if any. */
export function getOpenPullRequestForIssue(
  db: Database.Database,
  issueId: number,
): PullRequest | undefined {
  const row = db.prepare(`
    SELECT * FROM pull_requests
    WHERE issue_id = ? AND status NOT IN ('merged', 'closed')
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `).get(issueId) as PullRequestRow | undefined;
  return row ? toPullRequest(row) : undefined;
}

export function updatePullRequest(
  db: Database.Database,
  id: number,
  patch: UpdatePullRequestInput,
): PullRequest | undefined {
  const existing = getPullRequest(db, id);
  if (!existing) return undefined;
  const nextHeadSha = patch.headSha?.trim() || existing.headSha;
  const headChanged = nextHeadSha !== existing.headSha;
  const nextStatus = headChanged ? "draft" : patch.status ?? existing.status;
  const mergedAt = nextStatus === "merged" ? Date.now() : existing.mergedAt;

  db.prepare(`
    UPDATE pull_requests SET
      title = @title,
      description = @description,
      base_branch = @baseBranch,
      base_sha = @baseSha,
      head_branch = @headBranch,
      head_sha = @headSha,
      author = @author,
      status = @status,
      active_review_run_id = @activeReviewRunId,
      updated_at = @updatedAt,
      merged_at = @mergedAt,
      merge_commit_sha = @mergeCommitSha
    WHERE id = @id
  `).run({
    id,
    title: patch.title?.trim() || existing.title,
    description: patch.description?.trim() ?? existing.description,
    baseBranch: patch.baseBranch?.trim() || existing.baseBranch,
    baseSha: patch.baseSha?.trim() || existing.baseSha,
    headBranch: patch.headBranch?.trim() || existing.headBranch,
    headSha: nextHeadSha,
    author: patch.author?.trim() || existing.author,
    status: nextStatus,
    activeReviewRunId: headChanged ? null : existing.activeReviewRunId ?? null,
    updatedAt: Date.now(),
    mergedAt: mergedAt ?? null,
    mergeCommitSha: patch.mergeCommitSha?.trim() || (existing.mergeCommitSha ?? null),
  });
  return getPullRequest(db, id);
}

export function listPullRequestReviews(
  db: Database.Database,
  pullRequestId: number,
): PullRequestReview[] {
  const rows = db.prepare(`
    SELECT * FROM pull_request_reviews
    WHERE pull_request_id = ?
    ORDER BY started_at DESC, id DESC
  `).all(pullRequestId) as PullRequestReviewRow[];
  return rows.map(toReview);
}

export function recordPullRequestReview(
  db: Database.Database,
  payload: HelixPullRequestReviewPayload,
): { pullRequest: PullRequest; review: PullRequestReview; stale: boolean } | undefined {
  const pullRequest = getPullRequest(db, payload.pullRequest.id);
  if (!pullRequest) return undefined;
  const reviewId = clean(payload.review.id);
  const headSha = clean(payload.review.headSha);
  if (!reviewId || !headSha) return undefined;

  const startedAt = finiteTimestamp(payload.review.startedAt) ?? Date.now();
  const finishedAt = finiteTimestamp(payload.review.finishedAt);
  const status = payload.review.status;
  const decision = validDecision(payload.review.decision);
  const findings = normalizeFindings(payload.review.findings);
  const checks = normalizeChecks(payload.review.checks);

  db.prepare(`
    INSERT INTO pull_request_reviews (
      pull_request_id, review_run_id, head_sha, status, decision, summary,
      findings_json, checks_json, started_at, finished_at
    ) VALUES (
      @pullRequestId, @reviewRunId, @headSha, @status, @decision, @summary,
      @findings, @checks, @startedAt, @finishedAt
    )
    ON CONFLICT(review_run_id) DO UPDATE SET
      status = excluded.status,
      decision = excluded.decision,
      summary = excluded.summary,
      findings_json = excluded.findings_json,
      checks_json = excluded.checks_json,
      finished_at = excluded.finished_at
  `).run({
    pullRequestId: pullRequest.id,
    reviewRunId: reviewId,
    headSha,
    status,
    decision: decision ?? null,
    summary: typeof payload.review.summary === "string" ? payload.review.summary : "",
    findings: JSON.stringify(findings),
    checks: JSON.stringify(checks),
    startedAt,
    finishedAt: finishedAt ?? null,
  });

  const stale = pullRequest.headSha !== headSha;
  if (!stale) {
    const nextStatus: PullRequestStatus =
      status === "running"
        ? "reviewing"
        : status === "error"
          ? "blocked"
          : decision ?? "blocked";
    db.prepare(`
      UPDATE pull_requests
      SET status = ?, active_review_run_id = ?, updated_at = ?
      WHERE id = ?
    `).run(nextStatus, reviewId, Date.now(), pullRequest.id);
  }

  return {
    pullRequest: getPullRequest(db, pullRequest.id)!,
    review: listPullRequestReviews(db, pullRequest.id).find((item) => item.reviewRunId === reviewId)!,
    stale,
  };
}

function toPullRequest(row: PullRequestRow): PullRequest {
  return {
    id: row.id,
    projectId: row.project_id,
    issueId: row.issue_id ?? undefined,
    title: row.title,
    description: row.description,
    repositoryPath: row.repository_path,
    baseBranch: row.base_branch,
    baseSha: row.base_sha,
    headBranch: row.head_branch,
    headSha: row.head_sha,
    author: row.author,
    origin: row.origin,
    status: row.status,
    activeReviewRunId: row.active_review_run_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    mergedAt: row.merged_at ?? undefined,
    mergeCommitSha: row.merge_commit_sha ?? undefined,
  };
}

function toReview(row: PullRequestReviewRow): PullRequestReview {
  return {
    id: row.id,
    pullRequestId: row.pull_request_id,
    reviewRunId: row.review_run_id,
    headSha: row.head_sha,
    status: row.status,
    decision: row.decision ?? undefined,
    summary: row.summary,
    findings: parseJson(row.findings_json),
    checks: parseJson(row.checks_json),
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function validDecision(value: unknown): PullRequestDecision | undefined {
  return value === "ready_to_merge" || value === "changes_requested" || value === "blocked"
    ? value
    : undefined;
}

function normalizeFindings(value: unknown): PullRequestReviewFinding[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PullRequestReviewFinding => {
    if (!item || typeof item !== "object") return false;
    const finding = item as Record<string, unknown>;
    return (
      (finding.severity === "blocking" || finding.severity === "warning" || finding.severity === "note") &&
      typeof finding.title === "string" &&
      typeof finding.details === "string"
    );
  });
}

function normalizeChecks(value: unknown): PullRequestReviewCheck[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PullRequestReviewCheck => {
    if (!item || typeof item !== "object") return false;
    const check = item as Record<string, unknown>;
    return (
      typeof check.name === "string" &&
      (check.status === "passed" || check.status === "failed" || check.status === "blocked") &&
      typeof check.summary === "string"
    );
  });
}

function parseJson<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}
