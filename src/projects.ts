import type Database from "better-sqlite3";
import {
  DEFAULT_COMMENT_TRIGGER,
  DEFAULT_LABEL_FILTER,
  DEFAULT_WEBHOOK_URL,
  type Project,
  type ProjectInput,
  type ProjectUpdate,
} from "./types.js";

interface ProjectRow {
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

const DEFAULT_BASE_URL = "http://127.0.0.1:8320";

export function listProjects(db: Database.Database): Project[] {
  const rows = db
    .prepare("SELECT * FROM projects ORDER BY title COLLATE NOCASE ASC, id ASC")
    .all() as ProjectRow[];
  return rows.map(toProject);
}

export function getProject(db: Database.Database, ref: string | number): Project | null {
  if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
    const id = Number(ref);
    if (!Number.isInteger(id) || id <= 0) return null;
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }
  const slug = String(ref).trim().toLowerCase();
  if (!slug) return null;
  const row = db.prepare("SELECT * FROM projects WHERE slug = ?").get(slug) as ProjectRow | undefined;
  return row ? toProject(row) : null;
}

export function createProject(db: Database.Database, input: ProjectInput): Project {
  const title = input.title.trim();
  if (!title) throw new Error("title is required");

  const slug = ensureUniqueSlug(db, input.slug?.trim() ? normalizeSlug(input.slug) : slugify(title));
  if (!slug) throw new Error("slug is required");

  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO projects (
         title, slug, webhook_url, label_filter, comment_trigger, webhook_enabled, base_url,
         created_at, updated_at
       ) VALUES (
         @title, @slug, @webhookUrl, @labelFilter, @commentTrigger, @webhookEnabled, @baseUrl,
         @now, @now
       )`,
    )
    .run({
      title,
      slug,
      webhookUrl: input.webhookUrl?.trim() ?? DEFAULT_WEBHOOK_URL,
      labelFilter: input.labelFilter?.trim() || DEFAULT_LABEL_FILTER,
      commentTrigger: input.commentTrigger?.trim() || DEFAULT_COMMENT_TRIGGER,
      webhookEnabled: input.webhookEnabled === true ? 1 : 0,
      baseUrl: input.baseUrl?.trim() || DEFAULT_BASE_URL,
      now,
    });

  return getProject(db, Number(result.lastInsertRowid))!;
}

export function updateProject(
  db: Database.Database,
  ref: string | number,
  patch: ProjectUpdate,
): Project | null {
  const existing = getProject(db, ref);
  if (!existing) return null;

  const title = patch.title !== undefined ? patch.title.trim() : existing.title;
  if (!title) throw new Error("title is required");

  let slug = existing.slug;
  if (patch.slug !== undefined) {
    const normalized = normalizeSlug(patch.slug);
    if (!normalized) throw new Error("slug is required");
    slug = normalized === existing.slug ? existing.slug : ensureUniqueSlug(db, normalized, existing.id);
  }

  const now = Date.now();
  db.prepare(
    `UPDATE projects SET
       title = @title,
       slug = @slug,
       webhook_url = @webhookUrl,
       label_filter = @labelFilter,
       comment_trigger = @commentTrigger,
       webhook_enabled = @webhookEnabled,
       base_url = @baseUrl,
       updated_at = @now
     WHERE id = @id`,
  ).run({
    id: existing.id,
    title,
    slug,
    webhookUrl: patch.webhookUrl !== undefined ? patch.webhookUrl.trim() : existing.webhookUrl,
    labelFilter:
      patch.labelFilter !== undefined
        ? patch.labelFilter.trim() || DEFAULT_LABEL_FILTER
        : existing.labelFilter,
    commentTrigger:
      patch.commentTrigger !== undefined
        ? patch.commentTrigger.trim() || DEFAULT_COMMENT_TRIGGER
        : existing.commentTrigger,
    webhookEnabled:
      patch.webhookEnabled !== undefined
        ? patch.webhookEnabled
          ? 1
          : 0
        : existing.webhookEnabled
          ? 1
          : 0,
    baseUrl: patch.baseUrl !== undefined ? patch.baseUrl.trim() || DEFAULT_BASE_URL : existing.baseUrl,
    now,
  });

  return getProject(db, existing.id);
}

export function deleteProject(db: Database.Database, ref: string | number): boolean {
  const existing = getProject(db, ref);
  if (!existing) return false;
  const result = db.prepare("DELETE FROM projects WHERE id = ?").run(existing.id);
  return result.changes > 0;
}

export function projectSettings(project: Project): {
  webhookUrl: string;
  labelFilter: string;
  commentTrigger: string;
  webhookEnabled: boolean;
  baseUrl: string;
} {
  return {
    webhookUrl: project.webhookUrl,
    labelFilter: project.labelFilter,
    commentTrigger: project.commentTrigger,
    webhookEnabled: project.webhookEnabled,
    baseUrl: project.baseUrl,
  };
}

export function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function slugify(title: string): string {
  return normalizeSlug(title) || "project";
}

function ensureUniqueSlug(db: Database.Database, base: string, excludeId?: number): string {
  const root = base || "project";
  let candidate = root;
  let n = 2;
  while (true) {
    const row = db.prepare("SELECT id FROM projects WHERE slug = ?").get(candidate) as
      | { id: number }
      | undefined;
    if (!row || (excludeId !== undefined && row.id === excludeId)) return candidate;
    candidate = `${root}-${n}`.slice(0, 64);
    n += 1;
  }
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    webhookUrl: row.webhook_url,
    labelFilter: row.label_filter,
    commentTrigger: row.comment_trigger,
    webhookEnabled: row.webhook_enabled === 1,
    baseUrl: row.base_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
