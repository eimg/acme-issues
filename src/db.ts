import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_COMMENT_TRIGGER,
  DEFAULT_LABEL_FILTER,
  DEFAULT_WEBHOOK_URL,
} from "./types.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function resolveDataDir(): string {
  return process.env.ACME_ISSUES_DATA_DIR ?? process.env.LOCAL_ISSUES_DATA_DIR ?? join(projectRoot, "data");
}

export function openDatabase(dataDir = resolveDataDir()): Database.Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "issues.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'closed')),
      labels TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      payload TEXT NOT NULL,
      status_code INTEGER,
      response_body TEXT,
      success INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
    CREATE INDEX IF NOT EXISTS idx_deliveries_issue ON webhook_deliveries(issue_id);

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      author TEXT NOT NULL DEFAULT 'system',
      source TEXT NOT NULL DEFAULT 'system',
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id);

    CREATE TABLE IF NOT EXISTS helix_runs (
      run_id TEXT PRIMARY KEY,
      issue_id INTEGER NOT NULL,
      parent_run_id TEXT,
      root_run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      trigger TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_helix_runs_issue ON helix_runs(issue_id, finished_at DESC);

    CREATE TABLE IF NOT EXISTS pull_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      repository_path TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      head_branch TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'unknown',
      origin TEXT NOT NULL CHECK(origin IN ('helix', 'external')),
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft', 'reviewing', 'changes_requested', 'blocked', 'ready_to_merge', 'merged', 'closed')),
      active_review_run_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      merged_at INTEGER,
      merge_commit_sha TEXT,
      FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pull_requests_status ON pull_requests(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pull_requests_issue ON pull_requests(issue_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS pull_request_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pull_request_id INTEGER NOT NULL,
      review_run_id TEXT NOT NULL UNIQUE,
      head_sha TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'error')),
      decision TEXT CHECK(decision IN ('ready_to_merge', 'changes_requested', 'blocked')),
      summary TEXT NOT NULL DEFAULT '',
      findings_json TEXT NOT NULL DEFAULT '[]',
      checks_json TEXT NOT NULL DEFAULT '[]',
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      FOREIGN KEY (pull_request_id) REFERENCES pull_requests(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_pull_request_reviews_pr
      ON pull_request_reviews(pull_request_id, started_at DESC);
  `);

  migrateIssuesStatusConstraint(db);
  migrateHelixRunsTrigger(db);
  migrateMultiProject(db);
  migrateProjectsHandoff(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

/** Existing DBs may still CHECK only open|closed; recreate table if needed. */
function migrateIssuesStatusConstraint(db: Database.Database): void {
  const table = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'issues'`)
    .get() as { sql: string } | undefined;
  if (!table?.sql || table.sql.includes("'in_progress'")) return;

  db.exec(`
    PRAGMA foreign_keys = OFF;

    CREATE TABLE issues_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'closed')),
      labels TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    INSERT INTO issues_new (id, title, body, status, labels, created_at, updated_at)
    SELECT id, title, body, status, labels, created_at, updated_at FROM issues;

    DROP TABLE issues;
    ALTER TABLE issues_new RENAME TO issues;
    CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);

    PRAGMA foreign_keys = ON;
  `);
}

function migrateHelixRunsTrigger(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(helix_runs)`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "trigger")) return;
  db.exec(`ALTER TABLE helix_runs ADD COLUMN trigger TEXT`);
}

function migrateMultiProject(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      webhook_url TEXT NOT NULL DEFAULT '',
      label_filter TEXT NOT NULL DEFAULT 'trigger',
      comment_trigger TEXT NOT NULL DEFAULT '/helix',
      webhook_enabled INTEGER NOT NULL DEFAULT 0,
      base_url TEXT NOT NULL DEFAULT 'http://127.0.0.1:8320',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const issueColumns = db.prepare(`PRAGMA table_info(issues)`).all() as Array<{ name: string }>;
  const prColumns = db.prepare(`PRAGMA table_info(pull_requests)`).all() as Array<{ name: string }>;
  const issuesHaveProject = issueColumns.some((c) => c.name === "project_id");
  const prsHaveProject = prColumns.some((c) => c.name === "project_id");
  if (issuesHaveProject && prsHaveProject) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id, id DESC)`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_pull_requests_project ON pull_requests(project_id, updated_at DESC)`,
    );
    return;
  }

  const now = Date.now();
  const configRows = db.prepare("SELECT key, value FROM config").all() as Array<{
    key: string;
    value: string;
  }>;
  const config = Object.fromEntries(configRows.map((r) => [r.key, r.value]));
  const issueCount = (
    db.prepare("SELECT COUNT(*) AS count FROM issues").get() as { count: number }
  ).count;
  const prCount = (
    db.prepare("SELECT COUNT(*) AS count FROM pull_requests").get() as { count: number }
  ).count;
  const projectCount = (
    db.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number }
  ).count;

  let defaultProjectId: number | null = null;
  if (projectCount > 0) {
    defaultProjectId = (
      db.prepare("SELECT id FROM projects ORDER BY id ASC LIMIT 1").get() as { id: number }
    ).id;
  } else if (issueCount > 0 || prCount > 0 || configRows.length > 0) {
    const result = db
      .prepare(
        `INSERT INTO projects (
           title, slug, webhook_url, label_filter, comment_trigger, webhook_enabled, base_url,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "Default",
        "default",
        config.webhookUrl ?? DEFAULT_WEBHOOK_URL,
        config.labelFilter ?? DEFAULT_LABEL_FILTER,
        config.commentTrigger ?? DEFAULT_COMMENT_TRIGGER,
        config.webhookEnabled === "true" ? 1 : 0,
        config.baseUrl ?? "http://127.0.0.1:8320",
        now,
        now,
      );
    defaultProjectId = Number(result.lastInsertRowid);
  }

  db.exec(`PRAGMA foreign_keys = OFF`);

  if (!issuesHaveProject) {
    db.exec(`
      CREATE TABLE issues_mp (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'closed')),
        labels TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
    `);
    if (defaultProjectId != null && issueCount > 0) {
      db.prepare(
        `INSERT INTO issues_mp (id, project_id, title, body, status, labels, created_at, updated_at)
         SELECT id, ?, title, body, status, labels, created_at, updated_at FROM issues`,
      ).run(defaultProjectId);
    }
    db.exec(`
      DROP TABLE issues;
      ALTER TABLE issues_mp RENAME TO issues;
      CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
      CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id, id DESC);
    `);
  }

  if (!prsHaveProject) {
    db.exec(`
      CREATE TABLE pull_requests_mp (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        issue_id INTEGER,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        repository_path TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        head_branch TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT 'unknown',
        origin TEXT NOT NULL CHECK(origin IN ('helix', 'external')),
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK(status IN ('draft', 'reviewing', 'changes_requested', 'blocked', 'ready_to_merge', 'merged', 'closed')),
        active_review_run_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        merged_at INTEGER,
        merge_commit_sha TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE SET NULL
      );
    `);
    if (defaultProjectId != null && prCount > 0) {
      db.prepare(
        `INSERT INTO pull_requests_mp (
           id, project_id, issue_id, title, description, repository_path, base_branch, base_sha,
           head_branch, head_sha, author, origin, status, active_review_run_id,
           created_at, updated_at, merged_at, merge_commit_sha
         )
         SELECT id, ?, issue_id, title, description, repository_path, base_branch, base_sha,
                head_branch, head_sha, author, origin, status, active_review_run_id,
                created_at, updated_at, merged_at, merge_commit_sha
         FROM pull_requests`,
      ).run(defaultProjectId);
    }
    db.exec(`
      DROP TABLE pull_requests;
      ALTER TABLE pull_requests_mp RENAME TO pull_requests;
      CREATE INDEX IF NOT EXISTS idx_pull_requests_status ON pull_requests(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pull_requests_issue ON pull_requests(issue_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pull_requests_project ON pull_requests(project_id, updated_at DESC);
    `);
  }

  db.exec(`PRAGMA foreign_keys = ON`);
}

function migrateProjectsHandoff(db: Database.Database): void {
  const issueColumns = db.prepare(`PRAGMA table_info(issues)`).all() as Array<{ name: string }>;
  if (!issueColumns.some((c) => c.name === "source_card_id")) {
    db.exec(`ALTER TABLE issues ADD COLUMN source_card_id TEXT`);
  }
  if (!issueColumns.some((c) => c.name === "projects_callback_url")) {
    db.exec(`ALTER TABLE issues ADD COLUMN projects_callback_url TEXT`);
  }
}
