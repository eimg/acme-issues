export type IssueStatus = "open" | "in_progress" | "closed";

export interface Project {
  id: number;
  title: string;
  slug: string;
  webhookUrl: string;
  labelFilter: string;
  commentTrigger: string;
  webhookEnabled: boolean;
  /** Callback base URL Helix (and others) use to reach this Issues project. */
  baseUrl: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectInput {
  title: string;
  slug?: string;
  webhookUrl?: string;
  labelFilter?: string;
  commentTrigger?: string;
  webhookEnabled?: boolean;
  baseUrl?: string;
}

export interface ProjectUpdate {
  title?: string;
  slug?: string;
  webhookUrl?: string;
  labelFilter?: string;
  commentTrigger?: string;
  webhookEnabled?: boolean;
  baseUrl?: string;
}

export interface Issue {
  id: number;
  projectId: number;
  title: string;
  body: string;
  status: IssueStatus;
  labels: string[];
  createdAt: number;
  updatedAt: number;
  url: string;
}

export interface IssueInput {
  title: string;
  body?: string;
  labels?: string[];
  status?: IssueStatus;
}

export interface IssueUpdate {
  title?: string;
  body?: string;
  status?: IssueStatus;
  labels?: string[];
}

/** Per-project Helix/webhook settings (formerly global AppConfig). */
export interface AppConfig {
  webhookUrl: string;
  labelFilter: string;
  commentTrigger: string;
  webhookEnabled: boolean;
  baseUrl: string;
}

export interface WebhookPayload {
  title: string;
  body: string;
  labels: string[];
  external?: {
    trackerUrl: string;
    issueId: number;
    projectId: number;
    projectSlug: string;
  };
}

export interface ContinuationWebhookPayload {
  instruction: string;
  externalEventId: string;
  trigger: string;
  projectId: number;
  projectSlug: string;
  /** When addressing PR feedback, Helix should update this local PR instead of creating another. */
  pullRequestId?: number;
  /** Existing head branch Helix should continue on when present locally. */
  pullRequestHeadBranch?: string;
}

export type OutboundWebhookPayload = WebhookPayload | ContinuationWebhookPayload;

export type PullRequestOrigin = "helix" | "external";
export type PullRequestStatus =
  | "draft"
  | "reviewing"
  | "changes_requested"
  | "blocked"
  | "ready_to_merge"
  | "merged"
  | "closed";

export type PullRequestDecision = "ready_to_merge" | "changes_requested" | "blocked";
export type ReviewFindingSeverity = "blocking" | "warning" | "note";

export interface PullRequest {
  id: number;
  projectId: number;
  issueId?: number;
  title: string;
  description: string;
  repositoryPath: string;
  baseBranch: string;
  baseSha: string;
  headBranch: string;
  headSha: string;
  author: string;
  origin: PullRequestOrigin;
  status: PullRequestStatus;
  activeReviewRunId?: string;
  createdAt: number;
  updatedAt: number;
  mergedAt?: number;
  mergeCommitSha?: string;
}

export interface PullRequestReviewFinding {
  severity: ReviewFindingSeverity;
  title: string;
  details: string;
}

export interface PullRequestReviewCheck {
  name: string;
  status: "passed" | "failed" | "blocked";
  summary: string;
}

export interface PullRequestReview {
  id: number;
  pullRequestId: number;
  reviewRunId: string;
  headSha: string;
  status: "running" | "completed" | "error";
  decision?: PullRequestDecision;
  summary: string;
  findings: PullRequestReviewFinding[];
  checks: PullRequestReviewCheck[];
  startedAt: number;
  finishedAt?: number;
}

export interface PullRequestReviewWebhookPayload {
  pullRequest: {
    id: number;
    title: string;
    description: string;
    repositoryPath: string;
    baseBranch: string;
    baseSha: string;
    headBranch: string;
    headSha: string;
    author: string;
    origin: PullRequestOrigin;
    issue?: {
      id: number;
      title: string;
      body: string;
    };
  };
  callback: {
    trackerUrl: string;
    pullRequestId: number;
    projectId: number;
    projectSlug: string;
  };
  externalEventId: string;
}

export interface HelixPullRequestReviewPayload {
  event: "pr.review.started" | "pr.review.completed";
  review: {
    id: string;
    status: "running" | "completed" | "error";
    headSha: string;
    startedAt: number;
    finishedAt?: number;
    decision?: PullRequestDecision;
    summary?: string;
    findings?: PullRequestReviewFinding[];
    checks?: PullRequestReviewCheck[];
  };
  pullRequest: {
    id: number;
  };
}

export interface HelixRunPayload {
  event: "run.started" | "run.completed";
  run: {
    id: string;
    status: string;
    startedAt: number;
    finishedAt?: number;
    parentRunId?: string;
    rootRunId?: string;
  };
  issue: {
    id: number;
    title: string;
  };
}

export interface HelixRunSummary {
  runId: string;
  issueId: number;
  parentRunId?: string;
  rootRunId: string;
  status: string;
  trigger?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface IssueHelixActivity {
  activeRun?: HelixRunSummary;
  latestCompletedRun?: HelixRunSummary;
}

export type HelixRunCompletedPayload = HelixRunPayload;

export interface IssueListQuery {
  status?: IssueStatus;
  label?: string;
  limit?: number;
  offset?: number;
}

export interface IssueListResult {
  items: Issue[];
  total: number;
  limit: number;
  offset: number;
}

export type CommentSource = "user" | "system" | "helix.webhook";

export interface IssueComment {
  id: number;
  issueId: number;
  author: string;
  source: CommentSource;
  body: string;
  createdAt: number;
}

export interface CommentInput {
  author?: string;
  source?: CommentSource;
  body: string;
}

export interface CommentUpdate {
  body?: string;
  author?: string;
}

export interface WebhookDelivery {
  id: number;
  issueId: number;
  url: string;
  payload: OutboundWebhookPayload;
  statusCode: number | null;
  responseBody: string | null;
  success: boolean;
  attempts: number;
  error: string | null;
  createdAt: number;
}

export const DEFAULT_PORT = 8320;
export const DEFAULT_WEBHOOK_URL = "";
export const DEFAULT_LABEL_FILTER = "trigger";
export const DEFAULT_COMMENT_TRIGGER = "/helix";
