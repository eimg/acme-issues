import type Database from "better-sqlite3";

export interface SteeringNotification {
  schemaVersion: "acme.steering.notification.v1";
  id: string;
  source: {
    product: "acme-issues";
    instanceId?: string;
    resourceType: string;
    resourceId: string;
    revision: string;
    url?: string;
  };
  event: {
    type: string;
    occurredAt: string;
    summary: string;
    detail?: string;
  };
  steering?: {
    caseKey: string;
    state: "open" | "resolved" | "withdrawn" | "superseded";
    kind?: "decision" | "clarification" | "revision" | "exception" | "escalation" | "intervention";
    title?: string;
    action?: string;
    reason?: string;
    proposedAction?: string;
    recommendation?: string;
    risk?: "low" | "medium" | "high";
    reversible?: boolean;
    facts?: Record<string, string | number | boolean | undefined>;
  };
}

export interface SteeringActionRequest {
  schemaVersion: "acme.steering.action.v1";
  requestId: string;
  caseId: string;
  decisionId: string;
  actionKey: string;
  resource: { type: string; id: string; expectedRevision: string };
  input?: Record<string, unknown>;
}

export interface SteeringActionReceipt {
  schemaVersion: "acme.steering.action-receipt.v1";
  requestId: string;
  status: "applied" | "already_applied" | "accepted" | "stale" | "rejected" | "unavailable";
  sourceRevision: string;
  summary: string;
  eventId?: string;
  operationId?: string;
}

export function parseSteeringActionRequest(value: unknown): SteeringActionRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<SteeringActionRequest>;
  if (item.schemaVersion !== "acme.steering.action.v1" || !text(item.requestId) || !text(item.caseId)
    || !text(item.decisionId) || !text(item.actionKey) || !item.resource
    || !text(item.resource.type) || !text(item.resource.id) || !text(item.resource.expectedRevision)) return undefined;
  return item as SteeringActionRequest;
}

export interface SteeringDecisionNotice {
  schemaVersion: "acme.steering.decision.v1";
  decisionId: string;
  caseId: string;
  actionKey: string;
  resolution: "approve" | "reject" | "request_revision" | "defer" | "escalate" | "cancel";
  rationale: string;
  decidedAt: string;
  actor: {
    id: string;
    issuer: string;
    username: string;
    displayName: string;
    kind: "human" | "service" | "development";
  };
  resource: { type: string; id: string; expectedRevision: string };
}

export interface SteeringDecisionReceipt {
  schemaVersion: "acme.steering.decision-receipt.v1";
  decisionId: string;
  status: "recorded" | "already_recorded" | "stale" | "rejected" | "unavailable";
  sourceRevision: string;
  summary: string;
}

export interface StoredSteeringDecision extends SteeringDecisionNotice {
  receiptStatus: "recorded" | "stale";
  sourceRevision: string;
  receivedAt: string;
}

export function parseSteeringDecisionNotice(value: unknown): SteeringDecisionNotice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<SteeringDecisionNotice>;
  if (item.schemaVersion !== "acme.steering.decision.v1" || !text(item.decisionId) || !text(item.caseId)
    || !text(item.actionKey) || !["approve", "reject", "request_revision", "defer", "escalate", "cancel"].includes(String(item.resolution))
    || typeof item.rationale !== "string" || !text(item.decidedAt) || Number.isNaN(Date.parse(String(item.decidedAt)))
    || !item.actor || !text(item.actor.id) || !text(item.actor.issuer) || !text(item.actor.username)
    || !text(item.actor.displayName) || !["human", "service", "development"].includes(String(item.actor.kind))
    || !item.resource || !text(item.resource.type) || !text(item.resource.id) || !text(item.resource.expectedRevision)) return undefined;
  return item as SteeringDecisionNotice;
}

export function ensureSteeringDecisionStore(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS steering_decisions (
      decision_id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      action_key TEXT NOT NULL,
      resolution TEXT NOT NULL,
      rationale TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      expected_revision TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      receipt_status TEXT NOT NULL CHECK(receipt_status IN ('recorded', 'stale')),
      decided_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      notice_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_steering_decisions_resource
      ON steering_decisions(resource_type, resource_id, received_at DESC);
  `);
}

export function recordSteeringDecision(
  db: Database.Database,
  notice: SteeringDecisionNotice,
  currentRevision: string,
): SteeringDecisionReceipt {
  ensureSteeringDecisionStore(db);
  const encoded = JSON.stringify(notice);
  const existing = db.prepare("SELECT notice_json, source_revision FROM steering_decisions WHERE decision_id = ?")
    .get(notice.decisionId) as { notice_json: string; source_revision: string } | undefined;
  if (existing) {
    return existing.notice_json === encoded
      ? decisionReceipt(notice.decisionId, "already_recorded", existing.source_revision, "This Steering decision was already recorded.")
      : decisionReceipt(notice.decisionId, "rejected", currentRevision, "The decision id is already bound to a different payload.");
  }
  const status = currentRevision === notice.resource.expectedRevision ? "recorded" : "stale";
  const receivedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO steering_decisions (
      decision_id, case_id, action_key, resolution, rationale, actor_json,
      resource_type, resource_id, expected_revision, source_revision,
      receipt_status, decided_at, received_at, notice_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    notice.decisionId, notice.caseId, notice.actionKey, notice.resolution, notice.rationale,
    JSON.stringify(notice.actor), notice.resource.type, notice.resource.id,
    notice.resource.expectedRevision, currentRevision, status, notice.decidedAt, receivedAt, encoded,
  );
  return decisionReceipt(
    notice.decisionId,
    status,
    currentRevision,
    status === "recorded"
      ? "The source recorded the Steering decision without applying a generic workflow transition."
      : "The source recorded the Steering decision, but its referenced workflow revision is stale.",
  );
}

export function listSteeringDecisions(
  db: Database.Database,
  resourceType: string,
  resourceId: string,
): StoredSteeringDecision[] {
  ensureSteeringDecisionStore(db);
  const rows = db.prepare(`
    SELECT notice_json, receipt_status, source_revision, received_at
    FROM steering_decisions
    WHERE resource_type = ? AND resource_id = ?
    ORDER BY received_at DESC, decision_id DESC
  `).all(resourceType, resourceId) as Array<{
    notice_json: string; receipt_status: "recorded" | "stale"; source_revision: string; received_at: string;
  }>;
  return rows.map((row) => ({
    ...(JSON.parse(row.notice_json) as SteeringDecisionNotice),
    receiptStatus: row.receipt_status,
    sourceRevision: row.source_revision,
    receivedAt: row.received_at,
  }));
}

function decisionReceipt(
  decisionId: string,
  status: SteeringDecisionReceipt["status"],
  sourceRevision: string,
  summary: string,
): SteeringDecisionReceipt {
  return { schemaVersion: "acme.steering.decision-receipt.v1", decisionId, status, sourceRevision, summary };
}


export function createSteeringNotifier(
  fetchFn: typeof fetch = fetch,
  baseUrl = process.env.ACME_STEERING_URL,
  token = process.env.ACME_STEERING_TOKEN,
  trustedOrigins = process.env.ACME_TRUSTED_STEERING_ORIGINS,
): (notification: SteeringNotification) => void {
  const endpoint = baseUrl?.trim() ? `${baseUrl.replace(/\/$/, "")}/api/notifications` : undefined;
  const trusted = new Set((trustedOrigins ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  let attachToken = false;
  if (endpoint) {
    try {
      attachToken = Boolean(token?.trim() && trusted.has(new URL(endpoint).origin));
    } catch {
      console.warn(`[steering] invalid ACME_STEERING_URL: ${baseUrl}`);
      return () => undefined;
    }
  }
  return (notification) => {
    if (!endpoint) return;
    void fetchFn(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(attachToken ? { authorization: `Bearer ${token!.trim()}` } : {}),
      },
      body: JSON.stringify({
        ...notification,
        source: { ...notification.source, instanceId: notification.source.instanceId ?? process.env.ACME_STEERING_INSTANCE_ID ?? "default" },
      }),
      signal: AbortSignal.timeout(2_000),
    }).then((response) => {
      if (!response.ok) console.warn(`[steering] notification rejected (${response.status}): ${notification.id}`);
    }).catch((error: unknown) => {
      console.warn(`[steering] notification unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
