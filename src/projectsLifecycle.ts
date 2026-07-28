import type { Issue, Project } from "./types.js";
import { serviceAuthHeaderFor } from "./serviceAuth.js";

export type ProjectsLifecycleEvent =
  | "implementation.started"
  | "implementation.in_review"
  | "implementation.completed";

export interface ProjectsLifecyclePayload {
  event: ProjectsLifecycleEvent;
  issueId: number;
  sourceCardId: string;
  projectId: number;
  projectSlug: string;
  externalEventId: string;
  pullRequestId?: number;
}

export type FetchFn = typeof fetch;

/**
 * Best-effort callback to Acme Projects. Failures never roll back Issues state.
 */
export async function notifyProjectsLifecycle(
  issue: Issue,
  project: Project,
  event: ProjectsLifecycleEvent,
  opts: {
    fetchFn?: FetchFn;
    pullRequestId?: number;
    externalEventId: string;
    trustedOrigins?: string[];
  },
): Promise<{ ok: boolean; error?: string } | null> {
  const callbackUrl = issue.projectsCallbackUrl?.trim();
  const sourceCardId = issue.sourceCardId?.trim();
  if (!callbackUrl || !sourceCardId) return null;

  const payload: ProjectsLifecyclePayload = {
    event,
    issueId: issue.id,
    sourceCardId,
    projectId: project.id,
    projectSlug: project.slug,
    externalEventId: opts.externalEventId,
    ...(opts.pullRequestId !== undefined ? { pullRequestId: opts.pullRequestId } : {}),
  };

  try {
    const res = await (opts.fetchFn ?? fetch)(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Issues-Event": event,
        "X-Issues-Issue-Id": String(issue.id),
        "X-Issues-Project-Id": String(project.id),
        ...serviceAuthHeaderFor(callbackUrl, process.env.ACME_PROJECTS_TOKEN, {
          configuredOrigins: opts.trustedOrigins,
          envOrigins: process.env.ACME_TRUSTED_PROJECTS_ORIGINS,
          defaultOrigin: "http://127.0.0.1:8321",
          tokenName: "ACME_PROJECTS_TOKEN",
        }),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
