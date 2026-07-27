import type Database from "better-sqlite3";
import type {
  AppConfig,
  Issue,
  IssueInput,
  IssueListQuery,
  IssueListResult,
  IssueStatus,
  IssueUpdate,
  Project,
} from "./types.js";

interface IssueRow {
  id: number;
  project_id: number;
  title: string;
  body: string;
  status: IssueStatus;
  labels: string;
  created_at: number;
  updated_at: number;
}

function parseLabels(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((l): l is string => typeof l === "string");
  } catch {
    return [];
  }
}

function normalizeLabels(labels: string[] | undefined): string[] {
  if (!labels) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const label of labels) {
    const trimmed = label.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function toIssue(row: IssueRow, project: Project): Issue {
  const base = project.baseUrl.replace(/\/$/, "");
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    body: row.body,
    status: row.status,
    labels: parseLabels(row.labels),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    url: `${base}/?project=${encodeURIComponent(project.slug)}&issue=${row.id}`,
  };
}

const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 100;

export function listIssues(
  db: Database.Database,
  project: Project,
  query: IssueListQuery = {},
): IssueListResult {
  const limit = clampLimit(query.limit);
  const offset = Math.max(0, Number.isFinite(query.offset) ? Number(query.offset) : 0);
  const status = query.status;
  const label = query.label?.trim() || undefined;

  const where: string[] = ["project_id = ?"];
  const params: unknown[] = [project.id];

  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (label) {
    where.push(`EXISTS (
      SELECT 1 FROM json_each(issues.labels) AS jl
      WHERE jl.value = ?
    )`);
    params.push(label);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;
  const total = (
    db.prepare(`SELECT COUNT(*) AS count FROM issues ${whereSql}`).get(...params) as {
      count: number;
    }
  ).count;

  const rows = db
    .prepare(
      `SELECT * FROM issues
       ${whereSql}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as IssueRow[];

  return {
    items: rows.map((row) => toIssue(row, project)),
    total,
    limit,
    offset,
  };
}

function clampLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.floor(n), MAX_PAGE_LIMIT);
}

export function getIssue(
  db: Database.Database,
  project: Project,
  id: number,
): Issue | null {
  const row = db
    .prepare("SELECT * FROM issues WHERE id = ? AND project_id = ?")
    .get(id, project.id) as IssueRow | undefined;
  return row ? toIssue(row, project) : null;
}

/** Resolve an issue by id across projects (Helix callbacks). */
export function getIssueById(
  db: Database.Database,
  id: number,
): { issue: Issue; project: Project } | null {
  const row = db.prepare("SELECT * FROM issues WHERE id = ?").get(id) as IssueRow | undefined;
  if (!row) return null;
  const projectRow = db.prepare("SELECT * FROM projects WHERE id = ?").get(row.project_id) as
    | {
        id: number;
        title: string;
        slug: string;
        webhook_url: string;
        label_filter: string;
        comment_trigger: string;
        webhook_enabled: number;
        base_url: string;
        created_at: number;
        updated_at: number;
      }
    | undefined;
  if (!projectRow) return null;
  const project: Project = {
    id: projectRow.id,
    title: projectRow.title,
    slug: projectRow.slug,
    webhookUrl: projectRow.webhook_url,
    labelFilter: projectRow.label_filter,
    commentTrigger: projectRow.comment_trigger,
    webhookEnabled: projectRow.webhook_enabled === 1,
    baseUrl: projectRow.base_url,
    createdAt: projectRow.created_at,
    updatedAt: projectRow.updated_at,
  };
  return { issue: toIssue(row, project), project };
}

export function createIssue(
  db: Database.Database,
  project: Project,
  input: IssueInput,
): Issue {
  const now = Date.now();
  const labels = normalizeLabels(input.labels);
  const result = db
    .prepare(
      `INSERT INTO issues (project_id, title, body, status, labels, created_at, updated_at)
       VALUES (@projectId, @title, @body, @status, @labels, @now, @now)`,
    )
    .run({
      projectId: project.id,
      title: input.title.trim(),
      body: input.body?.trim() ?? "",
      status: input.status ?? "open",
      labels: JSON.stringify(labels),
      now,
    });

  return getIssue(db, project, Number(result.lastInsertRowid))!;
}

export function updateIssue(
  db: Database.Database,
  project: Project,
  id: number,
  patch: IssueUpdate,
): Issue | null {
  const existing = getIssue(db, project, id);
  if (!existing) return null;

  const title = patch.title !== undefined ? patch.title.trim() : existing.title;
  const body = patch.body !== undefined ? patch.body.trim() : existing.body;
  const status = patch.status ?? existing.status;
  const labels = patch.labels !== undefined ? normalizeLabels(patch.labels) : existing.labels;
  const now = Date.now();

  db.prepare(
    `UPDATE issues
     SET title = @title, body = @body, status = @status, labels = @labels, updated_at = @now
     WHERE id = @id AND project_id = @projectId`,
  ).run({
    id,
    projectId: project.id,
    title,
    body,
    status,
    labels: JSON.stringify(labels),
    now,
  });

  return getIssue(db, project, id);
}

export function deleteIssue(db: Database.Database, projectId: number, id: number): boolean {
  const result = db
    .prepare("DELETE FROM issues WHERE id = ? AND project_id = ?")
    .run(id, projectId);
  return result.changes > 0;
}

export function issueMatchesFilter(issue: Issue, labelFilter: string): boolean {
  return issue.status === "open" && issue.labels.includes(labelFilter);
}

export function labelWasAdded(oldLabels: string[], newLabels: string[], label: string): boolean {
  return !oldLabels.includes(label) && newLabels.includes(label);
}

export function issueToWebhookPayload(
  issue: Issue,
  project: Project,
): {
  title: string;
  body: string;
  labels: string[];
  external: {
    trackerUrl: string;
    issueId: number;
    projectId: number;
    projectSlug: string;
  };
} {
  return {
    title: issue.title,
    body: issue.body,
    labels: issue.labels,
    external: {
      trackerUrl: project.baseUrl.replace(/\/$/, ""),
      issueId: issue.id,
      projectId: project.id,
      projectSlug: project.slug,
    },
  };
}

export function listDeliveries(
  db: Database.Database,
  projectId: number,
  limit = 50,
): import("./types.js").WebhookDelivery[] {
  const rows = db
    .prepare(
      `SELECT d.id, d.issue_id, d.url, d.payload, d.status_code, d.response_body, d.success,
              d.attempts, d.error, d.created_at
       FROM webhook_deliveries d
       INNER JOIN issues i ON i.id = d.issue_id
       WHERE i.project_id = ?
       ORDER BY d.id DESC
       LIMIT ?`,
    )
    .all(projectId, limit) as {
    id: number;
    issue_id: number;
    url: string;
    payload: string;
    status_code: number | null;
    response_body: string | null;
    success: number;
    attempts: number;
    error: string | null;
    created_at: number;
  }[];

  return rows.map((row) => ({
    id: row.id,
    issueId: row.issue_id,
    url: row.url,
    payload: JSON.parse(row.payload) as import("./types.js").OutboundWebhookPayload,
    statusCode: row.status_code,
    responseBody: row.response_body,
    success: row.success === 1,
    attempts: row.attempts,
    error: row.error,
    createdAt: row.created_at,
  }));
}

export function deleteDelivery(
  db: Database.Database,
  projectId: number,
  id: number,
): boolean {
  const result = db
    .prepare(
      `DELETE FROM webhook_deliveries
       WHERE id = ?
         AND issue_id IN (SELECT id FROM issues WHERE project_id = ?)`,
    )
    .run(id, projectId);
  return result.changes > 0;
}

export function clearDeliveries(db: Database.Database, projectId: number): number {
  const result = db
    .prepare(
      `DELETE FROM webhook_deliveries
       WHERE issue_id IN (SELECT id FROM issues WHERE project_id = ?)`,
    )
    .run(projectId);
  return result.changes;
}

export function recordDelivery(
  db: Database.Database,
  entry: {
    issueId: number;
    url: string;
    payload: import("./types.js").OutboundWebhookPayload;
    statusCode: number | null;
    responseBody: string | null;
    success: boolean;
    attempts: number;
    error: string | null;
  },
): import("./types.js").WebhookDelivery {
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO webhook_deliveries
       (issue_id, url, payload, status_code, response_body, success, attempts, error, created_at)
       VALUES (@issueId, @url, @payload, @statusCode, @responseBody, @success, @attempts, @error, @now)`,
    )
    .run({
      issueId: entry.issueId,
      url: entry.url,
      payload: JSON.stringify(entry.payload),
      statusCode: entry.statusCode,
      responseBody: entry.responseBody,
      success: entry.success ? 1 : 0,
      attempts: entry.attempts,
      error: entry.error,
      now,
    });

  const id = Number(result.lastInsertRowid);
  return {
    id,
    issueId: entry.issueId,
    url: entry.url,
    payload: entry.payload,
    statusCode: entry.statusCode,
    responseBody: entry.responseBody,
    success: entry.success,
    attempts: entry.attempts,
    error: entry.error,
    createdAt: now,
  };
}

export type { AppConfig };
