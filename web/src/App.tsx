import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  Issue,
  IssueComment,
  IssueHelixActivity,
  IssueListResult,
  IssueStatus,
  HelixRunSummary,
  Project,
  ProjectInput,
  ProjectUpdate,
  PullRequest,
  PullRequestReview,
  PullRequestStatus,
  WebhookDelivery,
} from "../../src/types";
import type { HelixStatus } from "../../src/helixStatus";
import { hasPermission } from "acme-identity/permissions";
import type { AuthMode, Principal } from "acme-identity/types";
import { api, formatStatus, formatTime, projectApiPath } from "./api";

type View = "issues" | "pull-requests";
type Screen = "workspace" | "settings" | "new-project";
type IssueDetailData = Issue & { helix?: IssueHelixActivity };
type PullRequestDetailData = PullRequest & {
  reviews: PullRequestReview[];
  helix?: IssueHelixActivity;
  mergeCommands?: {
    cwd: string;
    shell: string;
    lines: string[];
  };
};

type AuthSession = {
  schemaVersion: "acme.session.v1";
  authMode: AuthMode;
  principal: Principal;
};

type IssuesAuth = {
  session: AuthSession;
  canWrite: boolean;
  signOut: () => void;
  signingOut: boolean;
};

const IssuesAuthContext = createContext<IssuesAuth | null>(null);

function useIssuesAuth(): IssuesAuth {
  const value = useContext(IssuesAuthContext);
  if (!value) throw new Error("Issues auth context is unavailable");
  return value;
}

function parseScreen(value: string | null): Screen {
  return value === "settings" || value === "new-project" ? value : "workspace";
}

export function App() {
  const client = useQueryClient();
  const auth = useQuery({
    queryKey: ["auth-session"],
    queryFn: () => api<AuthSession>("/api/auth/session"),
    retry: false,
  });
  const signOut = useMutation({
    mutationFn: () => api("/api/auth/session", { method: "DELETE" }),
    onSuccess: async () => {
      client.clear();
      await auth.refetch();
    },
  });

  if (auth.isLoading) return <AuthLoading />;
  if (!auth.data?.principal) {
    return (
      <Login
        error={auth.error?.message === "Authentication required" ? undefined : auth.error?.message}
        onSignedIn={async () => {
          await client.invalidateQueries({ queryKey: ["auth-session"] });
        }}
      />
    );
  }

  return (
    <IssuesAuthContext.Provider value={{
      session: auth.data,
      canWrite: hasPermission(auth.data.principal, "issues.write"),
      signOut: () => signOut.mutate(),
      signingOut: signOut.isPending,
    }}>
      <AuthenticatedApp />
    </IssuesAuthContext.Provider>
  );
}

function AuthenticatedApp() {
  const { canWrite } = useIssuesAuth();
  const deepLink = new URLSearchParams(location.search);
  const initialPr = positiveNumber(deepLink.get("pr"));
  const initialIssue = positiveNumber(deepLink.get("issue"));
  const initialProjectSlug = deepLink.get("project");
  const [view, setView] = useState<View>(initialPr ? "pull-requests" : "issues");
  const [screen, setScreen] = useState<Screen>(parseScreen(deepLink.get("screen")));
  const [selectedIssueId, setSelectedIssueId] = useState<number | null>(initialIssue);
  const [selectedPrId, setSelectedPrId] = useState<number | null>(initialPr);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(initialProjectSlug);
  const [dialog, setDialog] = useState<"issue" | null>(null);
  const [toast, setToast] = useState("");
  const [prProjectResolved, setPrProjectResolved] = useState(!initialPr || Boolean(initialProjectSlug));
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<Project[]>("/api/projects"),
  });
  const selectedProject = projects.data?.find((item) => item.slug === selectedSlug)
    ?? (prProjectResolved ? projects.data?.[0] : null)
    ?? null;

  useEffect(() => {
    if (!canWrite && screen !== "workspace") {
      setScreen("workspace");
    }
  }, [canWrite, screen]);

  useEffect(() => {
    if (!initialPr || initialProjectSlug || !projects.data?.length) {
      if (!initialPr || initialProjectSlug) setPrProjectResolved(true);
      return;
    }
    let cancelled = false;
    api<{ project: { slug: string } }>(`/api/pull-requests/${initialPr}`)
      .then((data) => {
        if (!cancelled && data.project?.slug) setSelectedSlug(data.project.slug);
      })
      .catch(() => {
        /* fall back to default project selection below */
      })
      .finally(() => {
        if (!cancelled) setPrProjectResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [initialPr, initialProjectSlug, projects.data]);

  useEffect(() => {
    if (!projects.data?.length) {
      if (screen === "settings") setScreen("new-project");
      return;
    }
    if (!prProjectResolved) return;
    if (!selectedSlug || !projects.data.some((item) => item.slug === selectedSlug)) {
      setSelectedSlug(projects.data[0].slug);
    }
  }, [projects.data, selectedSlug, screen, prProjectResolved]);

  useEffect(() => {
    if (!projects.data?.length) {
      syncAppUrl({
        project: null,
        screen: screen === "new-project" ? "new-project" : null,
        issue: null,
        pr: null,
      });
      return;
    }
    if (!selectedProject) return;
    syncAppUrl({
      project: selectedProject.slug,
      screen: screen === "workspace" ? null : screen,
      issue: screen === "workspace" && view === "issues" ? selectedIssueId : null,
      pr: screen === "workspace" && view === "pull-requests" ? selectedPrId : null,
    });
  }, [projects.data, selectedProject, screen, view, selectedIssueId, selectedPrId]);

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3_200);
  };
  const selectProject = (slug: string) => {
    setSelectedSlug(slug);
    setSelectedIssueId(null);
    setSelectedPrId(null);
    setScreen("workspace");
  };
  const backToWorkspace = () => setScreen("workspace");

  if (projects.isPending) {
    return <p className="query-state app-loading">Loading projects…</p>;
  }
  if (projects.isError) {
    return <p className="query-state react-error">{projects.error.message}</p>;
  }
  if (!projects.data?.length) {
    return (
      <>
        {screen === "new-project" && canWrite ? (
          <NewProjectScreen
            onBack={() => setScreen("workspace")}
            onCreated={(project) => {
              setSelectedSlug(project.slug);
              setScreen("workspace");
              showToast(`Project "${project.title}" created`);
            }}
          />
        ) : (
          <EmptyProjectsState onCreate={canWrite ? () => setScreen("new-project") : undefined} />
        )}
        {toast && <div className="toast" role="status">{toast}</div>}
      </>
    );
  }
  if (!selectedProject) {
    return <p className="query-state">Loading project…</p>;
  }

  if (screen === "settings" && canWrite) {
    return (
      <>
        <SettingsScreen
          project={selectedProject}
          onBack={backToWorkspace}
          onSaved={(updated) => {
            setSelectedSlug(updated.slug);
            setScreen("workspace");
            showToast("Settings saved");
          }}
          onDeleted={() => {
            setSelectedIssueId(null);
            setSelectedPrId(null);
            setSelectedSlug(null);
            setScreen("workspace");
            showToast("Project deleted");
          }}
        />
        {toast && <div className="toast" role="status">{toast}</div>}
      </>
    );
  }

  if (screen === "new-project" && canWrite) {
    return (
      <>
        <NewProjectScreen
          onBack={backToWorkspace}
          onCreated={(project) => {
            selectProject(project.slug);
            showToast(`Project "${project.title}" created`);
          }}
        />
        {toast && <div className="toast" role="status">{toast}</div>}
      </>
    );
  }

  return (
    <>
      <Header
        view={view}
        projects={projects.data}
        project={selectedProject}
        onView={(next) => {
          setView(next);
          if (next === "issues") setSelectedPrId(null);
          else setSelectedIssueId(null);
        }}
        onSelectProject={selectProject}
        onNewProject={canWrite ? () => setScreen("new-project") : undefined}
        onSettings={canWrite ? () => setScreen("settings") : undefined}
        onNewIssue={canWrite ? () => setDialog("issue") : undefined}
      />
      {view === "issues" ? (
        <IssuesWorkspace
          project={selectedProject}
          selectedId={selectedIssueId}
          onSelect={setSelectedIssueId}
          triggerLabel={selectedProject.labelFilter || "trigger"}
          showToast={showToast}
        />
      ) : (
        <PullRequestsWorkspace
          project={selectedProject}
          selectedId={selectedPrId}
          onSelect={setSelectedPrId}
          showToast={showToast}
        />
      )}
      {canWrite && dialog === "issue" && (
        <NewIssueDialog
          project={selectedProject}
          onClose={() => setDialog(null)}
          onCreated={(issue, message) => {
            setDialog(null);
            setView("issues");
            setSelectedIssueId(issue.id);
            showToast(message);
          }}
        />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}

function Header({
  view,
  projects,
  project,
  onView,
  onSelectProject,
  onNewProject,
  onSettings,
  onNewIssue,
}: {
  view: View;
  projects: Project[];
  project: Project;
  onView: (view: View) => void;
  onSelectProject: (slug: string) => void;
  onNewProject?: () => void;
  onSettings?: () => void;
  onNewIssue?: () => void;
}) {
  const { session, signOut, signingOut } = useIssuesAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  return (
    <header className="app-header">
      <div className="brand">
        <BrandMark />
        <div className="brand-text">
          <div className="project-selector" ref={menuRef}>
            <button
              type="button"
              className="project-selector-btn"
              aria-haspopup="listbox"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <h1>{project.title}</h1>
              <Icon name="chevron-down" className="project-selector-chevron" />
            </button>
            {menuOpen && (
              <div className="project-dropdown" role="listbox" aria-label="Projects">
                {projects.map((item) => (
                  <button
                    type="button"
                    key={item.slug}
                    role="option"
                    aria-selected={item.slug === project.slug}
                    className={`project-dropdown-item ${item.slug === project.slug ? "active" : ""}`}
                    onClick={() => {
                      onSelectProject(item.slug);
                      setMenuOpen(false);
                    }}
                  >
                    <span className="project-dropdown-title">{item.title}</span>
                    <span className="project-dropdown-slug">{item.slug}</span>
                  </button>
                ))}
                {onNewProject && <button
                  type="button"
                  className="project-dropdown-item project-dropdown-new"
                  onClick={() => {
                    setMenuOpen(false);
                    onNewProject();
                  }}
                >
                  <Icon name="plus" /> New project
                </button>}
              </div>
            )}
          </div>
          <p className="brand-tagline">Acme Issues · Local issue tracker with outbound webhooks</p>
        </div>
      </div>
      <div className="header-actions">
        <HelixTargetStatus project={project} />
        <div className="view-switcher" role="navigation" aria-label="Workspace">
          <button
            className={`view-switch ${view === "issues" ? "active" : ""}`}
            onClick={() => onView("issues")}
          >
            Issues
          </button>
          <button
            className={`view-switch ${view === "pull-requests" ? "active" : ""}`}
            onClick={() => onView("pull-requests")}
          >
            Pull requests
          </button>
        </div>
        <div className="identity-chip" title={session.principal.permissions.join(", ")}>
          <strong>{session.principal.displayName}</strong>
          <span>{session.principal.roles.join(", ") || session.principal.kind}</span>
        </div>
        {session.authMode === "local" && (
          <button className="btn btn-ghost" disabled={signingOut} onClick={signOut}>Sign out</button>
        )}
        {onSettings && <button className="btn btn-ghost" onClick={onSettings}>
          <Icon name="settings" /> Settings
        </button>}
        {onNewIssue && <button className="btn btn-primary" onClick={onNewIssue}>
          <Icon name="plus" /> New issue
        </button>}
      </div>
    </header>
  );
}

function HelixTargetStatus({ project }: { project: Project }) {
  const helix = useQuery({
    queryKey: ["helix-status", project.slug, project.webhookUrl, project.webhookEnabled],
    queryFn: () => api<HelixStatus>(projectApiPath(project.slug, "/helix")),
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  });
  const status = helix.data?.status ?? (helix.isError ? "offline" : null);
  const label =
    status === "online"
      ? "Helix · online"
      : status === "offline"
        ? "Helix · offline"
        : status === "unconfigured"
          ? "Connect Helix"
          : "Helix · …";
  const title = helix.data?.healthUrl
    ? `${helix.data.healthUrl}${project.webhookEnabled ? "" : " · webhooks disabled"}`
    : "Set a Helix webhook URL ending in /runs in project settings";

  return (
    <div
      className={`helix-target-status ${status ?? "pending"}${project.webhookEnabled ? "" : " disabled"}`}
      title={title}
      role="status"
      aria-live="polite"
    >
      <span className="helix-target-dot" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function IssuesWorkspace({
  project,
  selectedId,
  onSelect,
  triggerLabel,
  showToast,
}: {
  project: Project;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  triggerLabel: string;
  showToast: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<IssueStatus | "">("");
  const [label, setLabel] = useState("");
  const [offset, setOffset] = useState(0);
  const query = useQuery({
    queryKey: ["issues", project.slug, status, label, offset],
    queryFn: () => api<IssueListResult>(
      `${projectApiPath(project.slug, "/issues")}?limit=25&offset=${offset}&status=${status}&label=${encodeURIComponent(label)}`,
    ),
  });
  const deliveries = useQuery({
    queryKey: ["deliveries", project.slug],
    queryFn: () => api<WebhookDelivery[]>(
      `${projectApiPath(project.slug, "/webhooks/deliveries")}?limit=50`,
    ),
  });

  return (
    <main className="layout">
      <section className="panel issues-panel" aria-label="Issue list">
        <div className="panel-header issues-panel-header">
          <div className="panel-title-row"><h2>Issues</h2></div>
          <div className="filters" role="group" aria-label="Filter by status">
            {(["", "open", "in_progress", "closed"] as const).map((value) => (
              <button
                key={value || "all"}
                className={`filter-btn ${status === value ? "active" : ""}`}
                onClick={() => {
                  setStatus(value);
                  setOffset(0);
                }}
              >
                {value ? formatStatus(value) : "All"}
              </button>
            ))}
          </div>
          <div className="list-toolbar">
            <Icon name="search" className="toolbar-icon" />
            <input
              className="input label-filter-input"
              value={label}
              onChange={(event) => {
                setLabel(event.target.value);
                setOffset(0);
              }}
              placeholder="Filter by label"
            />
          </div>
        </div>
        {query.isPending ? (
          <p className="query-state">Loading issues…</p>
        ) : query.isError ? (
          <QueryError error={query.error} />
        ) : (
          <>
            <ul className="issue-list">
              {query.data.items.map((issue) => (
                <li
                  key={issue.id}
                  className={`issue-item ${selectedId === issue.id ? "active" : ""}`}
                  onClick={() => onSelect(issue.id)}
                >
                  <h3>#{issue.id} {issue.title}</h3>
                  <div className="issue-meta">
                    <span className={`status ${issue.status}`}>{formatStatus(issue.status)}</span>
                    {" · "}{formatTime(issue.updatedAt)}
                  </div>
                  <div className="labels">
                    {issue.labels.map((item) => (
                      <span className={`label ${item === triggerLabel ? "trigger" : ""}`} key={item}>
                        {item}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
              {!query.data.items.length && <li className="issue-empty">No matching issues.</li>}
            </ul>
            <div className="pager">
              <button
                className="btn btn-ghost btn-sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 25))}
              >
                <Icon name="chevron-left" /> Prev
              </button>
              <span className="page-info">
                {query.data.total
                  ? `${offset + 1}–${Math.min(offset + 25, query.data.total)} of ${query.data.total}`
                  : "0 issues"}
              </span>
              <button
                className="btn btn-ghost btn-sm"
                disabled={offset + 25 >= query.data.total}
                onClick={() => setOffset(offset + 25)}
              >
                Next <Icon name="chevron-right" />
              </button>
            </div>
          </>
        )}
      </section>
      <IssueDetail
        project={project}
        id={selectedId}
        onDeleted={() => onSelect(null)}
        showToast={showToast}
        onChanged={() => queryClient.invalidateQueries({ queryKey: ["issues", project.slug] })}
      />
      <DeliveriesPanel project={project} query={deliveries} showToast={showToast} />
    </main>
  );
}

function IssueDetail({
  project,
  id,
  onChanged,
  onDeleted,
  showToast,
}: {
  project: Project;
  id: number | null;
  onChanged: () => void;
  onDeleted: () => void;
  showToast: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [watchUntil, setWatchUntil] = useState(Date.now() + 120_000);
  useEffect(() => setWatchUntil(Date.now() + 120_000), [id]);
  const issue = useQuery({
    queryKey: ["issue", project.slug, id],
    queryFn: () => api<IssueDetailData>(projectApiPath(project.slug, `/issues/${id}`)),
    enabled: id !== null,
    refetchInterval: (query) => (
      query.state.data?.status === "in_progress"
      || Boolean(query.state.data?.helix?.activeRun)
      || Date.now() < watchUntil
    ) ? 2_000 : false,
  });
  const comments = useQuery({
    queryKey: ["comments", project.slug, id],
    queryFn: () => api<IssueComment[]>(projectApiPath(project.slug, `/issues/${id}/comments`)),
    enabled: id !== null,
  });
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["issue", project.slug, id] }),
      queryClient.invalidateQueries({ queryKey: ["comments", project.slug, id] }),
      queryClient.invalidateQueries({ queryKey: ["deliveries", project.slug] }),
    ]);
    onChanged();
  };
  const patch = useMutation({
    mutationFn: (body: Partial<Issue>) => api<{ issue: Issue }>(projectApiPath(project.slug, `/issues/${id}`), {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    onSuccess: (result) => {
      showToast(result.issue.status === "closed" ? "Issue closed" : "Issue saved");
      void invalidate();
    },
  });
  const trigger = useMutation({
    mutationFn: () => api(projectApiPath(project.slug, `/issues/${id}/trigger`), { method: "POST" }),
    onSuccess: () => {
      setWatchUntil(Date.now() + 120_000);
      showToast("Webhook delivered");
      void invalidate();
    },
  });
  const addComment = useMutation({
    mutationFn: (body: string) => api(projectApiPath(project.slug, `/issues/${id}/comments`), {
      method: "POST",
      body: JSON.stringify({ body, author: "user" }),
    }),
    onSuccess: () => {
      setWatchUntil(Date.now() + 120_000);
      showToast("Comment added");
      void invalidate();
    },
  });
  const updateComment = useMutation({
    mutationFn: ({ commentId, body }: { commentId: number; body: string }) =>
      api(projectApiPath(project.slug, `/issues/${id}/comments/${commentId}`), {
        method: "PATCH",
        body: JSON.stringify({ body }),
      }),
    onSuccess: () => {
      showToast("Comment updated");
      void invalidate();
    },
  });
  const deleteComment = useMutation({
    mutationFn: (commentId: number) => api(projectApiPath(project.slug, `/issues/${id}/comments/${commentId}`), {
      method: "DELETE",
    }),
    onSuccess: () => {
      showToast("Comment deleted");
      void invalidate();
    },
  });
  const deleteIssue = useMutation({
    mutationFn: () => api(projectApiPath(project.slug, `/issues/${id}`), { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["issues", project.slug] });
      onDeleted();
      showToast("Issue deleted");
    },
  });

  if (id === null) return <section className="panel detail-panel"><EmptyIssue /></section>;
  if (issue.isPending) return <section className="panel detail-panel"><p className="query-state">Loading issue…</p></section>;
  if (issue.isError) return <section className="panel detail-panel"><QueryError error={issue.error} /></section>;
  return (
    <section className="panel detail-panel">
      <IssueEditor
        key={`${issue.data.id}:${issue.data.updatedAt}`}
        issue={issue.data}
        helix={issue.data.helix}
        comments={comments.data ?? []}
        busy={
          patch.isPending
          || trigger.isPending
          || addComment.isPending
          || updateComment.isPending
          || deleteComment.isPending
          || deleteIssue.isPending
        }
        onSave={(body) => patch.mutate(body)}
        onToggle={() => patch.mutate({
          status: issue.data.status === "closed" ? "open" : "closed",
        })}
        onTrigger={() => trigger.mutate()}
        onComment={(body) => addComment.mutate(body)}
        onUpdateComment={(commentId, body) => updateComment.mutate({ commentId, body })}
        onDeleteComment={(commentId) => {
          if (confirm("Delete this comment?")) deleteComment.mutate(commentId);
        }}
        onDelete={() => {
          if (confirm(`Delete issue #${id}?`)) deleteIssue.mutate();
        }}
      />
    </section>
  );
}

function IssueEditor(props: {
  issue: Issue;
  helix?: IssueHelixActivity;
  comments: IssueComment[];
  busy: boolean;
  onSave: (patch: Partial<Issue>) => void;
  onToggle: () => void;
  onTrigger: () => void;
  onComment: (body: string) => void;
  onUpdateComment: (commentId: number, body: string) => void;
  onDeleteComment: (commentId: number) => void;
  onDelete: () => void;
}) {
  const { canWrite } = useIssuesAuth();
  const [title, setTitle] = useState(props.issue.title);
  const [body, setBody] = useState(props.issue.body);
  const [labels, setLabels] = useState(props.issue.labels.join(", "));
  const [comment, setComment] = useState("");
  const [editingCommentId, setEditingCommentId] = useState<number | null>(null);
  const [editingCommentBody, setEditingCommentBody] = useState("");
  const activeRun = props.helix?.activeRun;
  return (
    <div className="issue-detail">
      <div className="detail-header">
        <span className="issue-number">Issue #{props.issue.id}</span>
        {canWrite && <div className="detail-actions">
          <button className="btn btn-secondary" disabled={props.busy || Boolean(activeRun)} onClick={props.onTrigger}>
            <Icon name="zap" /> Send webhook
          </button>
          <button className="btn btn-ghost" disabled={props.busy} onClick={props.onToggle}>
            {props.issue.status === "closed" ? "Reopen" : "Close issue"}
          </button>
          <button className="btn btn-danger" disabled={props.busy} onClick={props.onDelete}>
            <Icon name="trash" /> Delete
          </button>
        </div>}
      </div>
      {activeRun && <HelixRunBanner run={activeRun} />}
      <input className="input title-input" value={title} readOnly={!canWrite} onChange={(event) => setTitle(event.target.value)} />
      <textarea className="input body-input" rows={12} value={body} readOnly={!canWrite} onChange={(event) => setBody(event.target.value)} />
      <div className="labels-row">
        <label>Labels</label>
        <div className="labels-row-fields">
          <input className="input" value={labels} readOnly={!canWrite} onChange={(event) => setLabels(event.target.value)} />
          {canWrite && <button
            className="btn btn-primary"
            disabled={props.busy}
            onClick={() => props.onSave({
              title,
              body,
              labels: labels.split(",").map((item) => item.trim()).filter(Boolean),
            })}
          >
            Save
          </button>}
        </div>
      </div>
      <p className="meta">{formatStatus(props.issue.status)} · updated {formatTime(props.issue.updatedAt)}</p>
      <section className="comments-section">
        <h3>Comments</h3>
        <ul className="comment-list">
          {props.comments.map((item) => (
            <li
              className={`comment-item ${item.source === "helix.webhook" ? "helix-webhook" : item.source}`}
              key={item.id}
            >
              <div className="comment-head">
                <span className="comment-author">{item.author}</span>
                <div className="comment-head-actions">
                  <span>{formatTime(item.createdAt)}</span>
                  {canWrite && item.source === "user" && (
                    <div className="comment-actions">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          setEditingCommentId(item.id);
                          setEditingCommentBody(item.body);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() => props.onDeleteComment(item.id)}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {editingCommentId === item.id ? (
                <div className="comment-edit">
                  <textarea
                    className="input comment-edit-input"
                    rows={3}
                    value={editingCommentBody}
                    onChange={(event) => setEditingCommentBody(event.target.value)}
                  />
                  <div className="comment-edit-actions">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingCommentId(null)}>Cancel</button>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={!editingCommentBody.trim()}
                      onClick={() => {
                        props.onUpdateComment(item.id, editingCommentBody.trim());
                        setEditingCommentId(null);
                      }}
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : <p className="comment-body">{item.body}</p>}
            </li>
          ))}
          {!props.comments.length && <li className="comment-empty">No comments yet.</li>}
        </ul>
        {canWrite && <form
          className="comment-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!comment.trim() || activeRun) return;
            props.onComment(comment.trim());
            setComment("");
          }}
        >
          <textarea
            className="input comment-input"
            rows={3}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder={
              activeRun
                ? "Helix is running — wait for this continuation to finish before commenting /helix"
                : "Write a comment… Use /helix to request continuation"
            }
            disabled={Boolean(activeRun)}
          />
          <div className="comment-form-actions">
            <button className="btn btn-primary" disabled={props.busy || Boolean(activeRun) || !comment.trim()}>
              Add comment
            </button>
          </div>
        </form>}
      </section>
    </div>
  );
}

function HelixRunBanner({ run }: { run: HelixRunSummary }) {
  const feedback = run.trigger === "pull_request.address_feedback";
  return (
    <div className={`helix-run-banner ${feedback ? "feedback" : "running"}`} role="status">
      <span className="helix-run-pulse" aria-hidden="true" />
      <div>
        <strong>{feedback ? "Addressing review feedback" : "Helix run in progress"}</strong>
        <p>
          {feedback
            ? "Helix is continuing the linked implementation run with PR review findings."
            : "A Helix continuation is running for this issue."}
          {" "}
          Run <code>{run.runId}</code>
          {run.parentRunId ? <> · parent <code>{run.parentRunId}</code></> : null}
          {" · "}
          started {formatTime(run.startedAt)}
        </p>
      </div>
    </div>
  );
}

function DeliveriesPanel({
  project,
  query,
  showToast,
}: {
  project: Project;
  query: UseQueryResult<WebhookDelivery[], Error>;
  showToast: (message: string) => void;
}) {
  const { canWrite } = useIssuesAuth();
  const client = useQueryClient();
  const clear = useMutation({
    mutationFn: () => api(projectApiPath(project.slug, "/webhooks/deliveries"), { method: "DELETE" }),
    onSuccess: () => {
      showToast("Delivery logs cleared");
      void client.invalidateQueries({ queryKey: ["deliveries", project.slug] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(projectApiPath(project.slug, `/webhooks/deliveries/${id}`), { method: "DELETE" }),
    onSuccess: () => {
      showToast("Delivery removed");
      void client.invalidateQueries({ queryKey: ["deliveries", project.slug] });
    },
  });
  return (
    <section className="panel deliveries-panel">
      <div className="panel-header">
        <h2>Webhook deliveries</h2>
        <div className="panel-header-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => query.refetch()}>
            <Icon name="refresh" /> Refresh
          </button>
          {canWrite && <button className="btn btn-ghost btn-sm" disabled={clear.isPending} onClick={() => clear.mutate()}>Clear</button>}
        </div>
      </div>
      <ul className="delivery-list">
        {query.data?.map((delivery) => (
          <li className={`delivery-item ${delivery.success ? "success" : "failed"}`} key={delivery.id}>
            <div className="delivery-item-head">
              <div className={`delivery-status ${delivery.success ? "success" : "failed"}`}>
                #{delivery.issueId} · {delivery.success
                  ? `HTTP ${delivery.statusCode}`
                  : delivery.error || `HTTP ${delivery.statusCode ?? "error"}`}
              </div>
              {canWrite && <button
                type="button"
                className="btn btn-ghost btn-sm delivery-remove-btn"
                aria-label="Remove delivery"
                title="Remove"
                onClick={() => remove.mutate(delivery.id)}
              >
                ×
              </button>}
            </div>
            <div className="delivery-meta">
              {formatTime(delivery.createdAt)} · {delivery.attempts} attempt(s)
            </div>
            <div className="delivery-meta">{delivery.url}</div>
          </li>
        ))}
        {!query.isPending && !query.data?.length && <li className="delivery-empty">No webhook deliveries.</li>}
      </ul>
    </section>
  );
}

function PullRequestsWorkspace({
  project,
  selectedId,
  onSelect,
  showToast,
}: {
  project: Project;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  showToast: (message: string) => void;
}) {
  const { canWrite } = useIssuesAuth();
  const client = useQueryClient();
  const [status, setStatus] = useState<PullRequestStatus | "">("");
  const list = useQuery({
    queryKey: ["pull-requests", project.slug, status],
    queryFn: () => api<PullRequest[]>(
      `${projectApiPath(project.slug, "/pull-requests")}?status=${status}`,
    ),
  });
  const clear = useMutation({
    mutationFn: () => api<{ deleted: number }>(projectApiPath(project.slug, "/pull-requests"), { method: "DELETE" }),
    onSuccess: (result) => {
      onSelect(null);
      showToast(result.deleted === 1 ? "Deleted 1 pull request" : `Deleted ${result.deleted} pull requests`);
      void client.invalidateQueries({ queryKey: ["pull-requests", project.slug] });
      void client.invalidateQueries({ queryKey: ["pull-request", project.slug] });
    },
    onError: (error) => showToast(error.message),
  });
  return (
    <main className="pr-layout">
      <section className="panel pr-list-panel">
        <div className="panel-header pr-list-header">
          <div><h2>Local pull requests</h2><p>Git-backed changes awaiting human merge</p></div>
          <div className="panel-header-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => list.refetch()}>
              <Icon name="refresh" /> Refresh
            </button>
            {canWrite && <button
              className="btn btn-ghost btn-sm"
              disabled={clear.isPending || !list.data?.length}
              onClick={() => {
                if (!confirm("Delete all local pull request history and review records?")) return;
                clear.mutate();
              }}
            >
              {clear.isPending ? "Clearing…" : "Clear"}
            </button>}
          </div>
        </div>
        <div className="filters pr-filters">
          {([
            ["", "All"],
            ["reviewing", "Reviewing"],
            ["changes_requested", "Changes"],
            ["ready_to_merge", "Ready"],
          ] as const).map(([value, label]) => (
            <button
              className={`pr-filter-btn filter-btn ${status === value ? "active" : ""}`}
              key={value || "all"}
              onClick={() => setStatus(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <ul className="issue-list pr-list">
          {list.isPending && <li className="issue-empty">Loading pull requests…</li>}
          {list.isError && <li className="issue-empty react-error">{list.error.message}</li>}
          {list.data?.map((pr) => (
            <li
              className={`issue-item pr-item ${selectedId === pr.id ? "active" : ""}`}
              key={pr.id}
              onClick={() => onSelect(pr.id)}
            >
              <div className="pr-item-top">
                <h3>#{pr.id} {pr.title}</h3>
                <span className={`status pr-status ${pr.status}`}>{formatStatus(pr.status)}</span>
              </div>
              <div className="issue-meta">{pr.headBranch} → {pr.baseBranch}</div>
              <div className="issue-meta"><code>{pr.headSha.slice(0, 10)}</code> · {pr.origin}</div>
            </li>
          ))}
          {list.data && !list.data.length && <li className="issue-empty">No matching pull requests.</li>}
        </ul>
      </section>
      <PullRequestDetail
        project={project}
        id={selectedId}
        showToast={showToast}
        onDeleted={() => onSelect(null)}
      />
    </main>
  );
}

function PullRequestDetail({
  project,
  id,
  showToast,
  onDeleted,
}: {
  project: Project;
  id: number | null;
  showToast: (message: string) => void;
  onDeleted: () => void;
}) {
  const { canWrite } = useIssuesAuth();
  const client = useQueryClient();
  const detail = useQuery({
    queryKey: ["pull-request", project.slug, id],
    queryFn: () => api<PullRequestDetailData>(projectApiPath(project.slug, `/pull-requests/${id}`)),
    enabled: id !== null,
    refetchInterval: (query) => (
      query.state.data?.status === "reviewing" || Boolean(query.state.data?.helix?.activeRun)
    ) ? 2_000 : false,
  });
  const diff = useQuery({
    queryKey: ["pull-request-diff", project.slug, id],
    queryFn: () => api<{ diff: string }>(projectApiPath(project.slug, `/pull-requests/${id}/diff`)),
    enabled: id !== null,
    staleTime: Infinity,
  });
  const invalidate = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["pull-request", project.slug, id] }),
      client.invalidateQueries({ queryKey: ["pull-requests", project.slug] }),
      client.invalidateQueries({ queryKey: ["issue", project.slug] }),
      client.invalidateQueries({ queryKey: ["comments", project.slug] }),
      client.invalidateQueries({ queryKey: ["issues", project.slug] }),
    ]);
  };
  const review = useMutation({
    mutationFn: () => api(projectApiPath(project.slug, `/pull-requests/${id}/review`), { method: "POST" }),
    onSuccess: () => {
      showToast("Review requested");
      void invalidate();
    },
    onError: (error) => showToast(error.message),
  });
  const addressFeedback = useMutation({
    mutationFn: () => api(projectApiPath(project.slug, `/pull-requests/${id}/address-feedback`), { method: "POST" }),
    onSuccess: () => {
      showToast("Helix continuation requested to address review feedback");
      void invalidate();
    },
    onError: (error) => showToast(error.message),
  });
  const merge = useMutation({
    mutationFn: () => api<{ pullRequest: PullRequest; mergeCommitSha: string }>(
      projectApiPath(project.slug, `/pull-requests/${id}/merge`),
      { method: "POST" },
    ),
    onSuccess: (result) => {
      showToast(`Merged into ${result.pullRequest.baseBranch} (${result.mergeCommitSha.slice(0, 8)})`);
      void invalidate();
    },
    onError: (error) => showToast(error.message),
  });
  const recordMerged = useMutation({
    mutationFn: (mergeCommitSha?: string) => api(projectApiPath(project.slug, `/pull-requests/${id}`), {
      method: "PATCH",
      body: JSON.stringify({ status: "merged", mergeCommitSha }),
    }),
    onSuccess: () => {
      showToast("Local PR recorded as merged");
      void invalidate();
    },
    onError: (error) => showToast(error.message),
  });
  const remove = useMutation({
    mutationFn: () => api(projectApiPath(project.slug, `/pull-requests/${id}`), { method: "DELETE" }),
    onSuccess: () => {
      showToast(`Pull request #${id} deleted`);
      onDeleted();
      void client.invalidateQueries({ queryKey: ["pull-requests", project.slug] });
      void client.invalidateQueries({ queryKey: ["pull-request", project.slug] });
    },
    onError: (error) => showToast(error.message),
  });

  if (id === null) {
    return (
      <section className="panel pr-detail-panel">
        <div className="empty-state">
          <p className="empty-title">No pull request selected</p>
          <p className="empty-hint">Select a local PR to inspect its exact SHA, findings, checks, and diff.</p>
        </div>
      </section>
    );
  }
  if (detail.isPending) return <section className="panel pr-detail-panel"><p className="query-state">Loading pull request…</p></section>;
  if (detail.isError) return <section className="panel pr-detail-panel"><QueryError error={detail.error} /></section>;

  const pr = detail.data;
  const latest = pr.reviews.find((item) => item.headSha === pr.headSha);
  const reviewed = pr.reviews.some((item) => item.headSha === pr.headSha && item.status === "completed");
  const activeRun = pr.helix?.activeRun;
  const needsFeedback =
    (pr.status === "changes_requested" || pr.status === "blocked") && Boolean(pr.issueId);
  const closed = pr.status === "merged" || pr.status === "closed";
  return (
    <section className="panel pr-detail-panel">
      <article className="pr-detail">
        <div className="pr-detail-head">
          <div><span className="issue-number">Local PR #{pr.id}</span><h2>{pr.title}</h2></div>
          {canWrite && <div className="detail-actions">
            {!closed && needsFeedback && (
              <button
                className="btn btn-primary"
                disabled={Boolean(activeRun) || addressFeedback.isPending || review.isPending}
                title={activeRun ? "Helix is already addressing feedback for the linked issue" : undefined}
                onClick={() => {
                  if (
                    !confirm(
                      "Ask Helix to continue the linked implementation run and address this review feedback?",
                    )
                  ) {
                    return;
                  }
                  addressFeedback.mutate();
                }}
              >
                {activeRun
                  ? "Addressing feedback…"
                  : addressFeedback.isPending
                    ? "Starting…"
                    : "Address feedback"}
              </button>
            )}
            {!closed && (
              <button
                className={`btn ${reviewed ? "btn-secondary" : needsFeedback ? "btn-secondary" : "btn-primary"}`}
                disabled={pr.status === "reviewing" || review.isPending || addressFeedback.isPending || Boolean(activeRun)}
                onClick={() => review.mutate()}
              >
                {pr.status === "reviewing" ? "Review running…" : reviewed ? "Review again" : "Request review"}
              </button>
            )}
            {pr.status === "ready_to_merge" && (
              <>
                <button
                  className="btn btn-primary"
                  disabled={merge.isPending || recordMerged.isPending || remove.isPending}
                  onClick={() => {
                    if (
                      !confirm(
                        `Merge ${pr.headBranch} into ${pr.baseBranch} in\n${pr.repositoryPath}?`,
                      )
                    ) {
                      return;
                    }
                    merge.mutate();
                  }}
                >
                  {merge.isPending ? "Merging…" : `Merge into ${pr.baseBranch}`}
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={merge.isPending || recordMerged.isPending || remove.isPending}
                  title="Use when you already merged this head outside Acme Issues"
                  onClick={() => {
                    if (!confirm("Record this PR as merged without running git merge?")) return;
                    recordMerged.mutate(prompt("Merge commit SHA (optional):", "") || undefined);
                  }}
                >
                  Record only
                </button>
              </>
            )}
            <button
              className="btn btn-ghost"
              disabled={remove.isPending || merge.isPending || recordMerged.isPending}
              onClick={() => {
                if (!confirm(`Delete local PR #${pr.id} and its review history?`)) return;
                remove.mutate();
              }}
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </button>
          </div>}
        </div>
        {activeRun && <HelixRunBanner run={activeRun} />}
        <div className={`pr-status-banner ${pr.status}`}>{formatStatus(pr.status)}</div>
        {pr.status === "ready_to_merge" && pr.mergeCommands && (
          <MergeCommandPanel
            commands={pr.mergeCommands}
            onCopy={() => showToast("Merge command copied")}
          />
        )}
        <p className="pr-description">{pr.description || "No description."}</p>
        <dl className="pr-identity">
          <div><dt>Repository</dt><dd>{pr.repositoryPath}</dd></div>
          <div><dt>Branches</dt><dd>{pr.headBranch} → {pr.baseBranch}</dd></div>
          <div><dt>Base SHA</dt><dd><code>{pr.baseSha}</code></dd></div>
          <div><dt>Head SHA</dt><dd><code>{pr.headSha}</code></dd></div>
          <div><dt>Origin</dt><dd>{pr.origin} · {pr.author}</dd></div>
          <div>
            <dt>Linked issue</dt>
            <dd>{pr.issueId ? <a href={`/?project=${encodeURIComponent(project.slug)}&issue=${pr.issueId}`}>Issue #{pr.issueId}</a> : "None"}</dd>
          </div>
        </dl>
        <section className="pr-review-section">
          <h3>Latest review</h3>
          <div className="review-summary muted-card">{latest?.summary || "No review has run for this head SHA."}</div>
          <div className="review-columns">
            <ReviewItems
              title="Findings"
              items={latest?.findings.map((item) => ({
                badge: item.severity,
                title: item.title,
                body: item.details,
              })) ?? []}
            />
            <ReviewItems
              title="Checks"
              items={latest?.checks.map((item) => ({
                badge: item.status,
                title: item.name,
                body: item.summary,
              })) ?? []}
            />
          </div>
        </section>
        <section className="pr-diff-section">
          <div className="section-heading">
            <h3>Diff</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => diff.refetch()}>
              <Icon name="refresh" /> Reload
            </button>
          </div>
          <pre className="pr-diff">
            {diff.isPending ? "Loading…" : diff.isError ? diff.error.message : diff.data?.diff || "(no diff)"}
          </pre>
        </section>
        <details className="review-history">
          <summary>Review history</summary>
          <ul className="review-list">
            {pr.reviews.map((item) => (
              <li className="review-history-item" key={item.id}>
                <strong>{formatStatus(item.decision || item.status)}</strong>
                <code>{item.headSha.slice(0, 10)}</code>
                <span>{formatTime(item.finishedAt || item.startedAt)}</span>
              </li>
            ))}
            {!pr.reviews.length && <li className="review-empty">No review history.</li>}
          </ul>
        </details>
      </article>
    </section>
  );
}

function NewIssueDialog({
  project,
  onClose,
  onCreated,
}: {
  project: Project;
  onClose: () => void;
  onCreated: (issue: Issue, message: string) => void;
}) {
  const client = useQueryClient();
  const create = useMutation({
    mutationFn: (payload: { title: string; body: string; labels: string[] }) =>
      api<{ issue: Issue; delivery: WebhookDelivery | null }>(projectApiPath(project.slug, "/issues"), {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: async (result) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["issues", project.slug] }),
        client.invalidateQueries({ queryKey: ["deliveries", project.slug] }),
      ]);
      onCreated(
        result.issue,
        result.delivery
          ? result.delivery.success
            ? "Issue created — webhook delivered"
            : "Issue created — webhook failed"
          : "Issue created",
      );
    },
  });
  return (
    <Modal onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          create.mutate({
            title: String(form.get("title") || ""),
            body: String(form.get("body") || ""),
            labels: parseLabels(String(form.get("labels") || "")),
          });
        }}
      >
        <h2>New issue</h2>
        <p className="dialog-subtitle">File a bug, task, or idea — stored locally in SQLite.</p>
        <Field label="Title">
          <input name="title" className="input" required autoFocus autoComplete="off" placeholder="Short, descriptive summary" />
        </Field>
        <Field label="Body">
          <textarea name="body" className="input" rows={7} placeholder="Steps to reproduce, expected behavior, context…" />
        </Field>
        <Field label="Labels">
          <input name="labels" className="input" placeholder="trigger, bug" autoComplete="off" />
        </Field>
        <MutationError mutation={create} />
        <DialogActions onClose={onClose} busy={create.isPending} submitLabel="Create issue" />
      </form>
    </Modal>
  );
}

function SettingsScreen({
  project,
  onBack,
  onSaved,
  onDeleted,
}: {
  project: Project;
  onBack: () => void;
  onSaved: (project: Project) => void;
  onDeleted: () => void;
}) {
  const client = useQueryClient();
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const save = useMutation({
    mutationFn: (payload: ProjectUpdate) => api<Project>(projectApiPath(project.slug), {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
    onSuccess: async (updated) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["projects"] }),
        client.invalidateQueries({ queryKey: ["project", project.slug] }),
      ]);
      onSaved(updated);
    },
  });
  const remove = useMutation({
    mutationFn: () => api(projectApiPath(project.slug), { method: "DELETE" }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["projects"] });
      onDeleted();
    },
  });
  const deleteAllowed = deleteConfirm === project.slug || deleteConfirm === project.title;
  return (
    <FormScreen
      title="Project settings"
      subtitle={`Configure webhooks and Helix integration for ${project.title}.`}
      onBack={onBack}
    >
      <form
        className="form-screen-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          save.mutate({
            title: String(form.get("title") || ""),
            slug: String(form.get("slug") || ""),
            webhookUrl: String(form.get("webhookUrl") || ""),
            labelFilter: String(form.get("labelFilter") || ""),
            commentTrigger: String(form.get("commentTrigger") || ""),
            webhookEnabled: form.get("webhookEnabled") === "on",
            baseUrl: String(form.get("baseUrl") || ""),
          });
        }}
      >
        <Field label="Title">
          <input name="title" className="input" defaultValue={project.title} required autoComplete="off" />
        </Field>
        <Field label="Slug">
          <input name="slug" className="input" defaultValue={project.slug} required autoComplete="off" />
        </Field>
        <Field label="Callback URL (base URL)">
          <input name="baseUrl" className="input" defaultValue={project.baseUrl} placeholder="http://127.0.0.1:8320" autoComplete="off" />
        </Field>
        <Field label="Webhook URL">
          <input name="webhookUrl" className="input" defaultValue={project.webhookUrl} placeholder="http://127.0.0.1:8319/runs" autoComplete="off" />
        </Field>
        <Field label="Label filter">
          <input name="labelFilter" className="input" defaultValue={project.labelFilter} placeholder="trigger" autoComplete="off" />
        </Field>
        <Field label="Continuation comment command">
          <input name="commentTrigger" className="input" defaultValue={project.commentTrigger} placeholder="/helix" autoComplete="off" />
        </Field>
        <label className="checkbox-row">
          <input name="webhookEnabled" type="checkbox" defaultChecked={project.webhookEnabled} />
          <span>Enable webhooks</span>
        </label>
        <MutationError mutation={save} />
        <FormActions onCancel={onBack} busy={save.isPending} submitLabel="Save settings" />
      </form>
      <section className="danger-zone">
        <h3>Delete project</h3>
        <p className="danger-zone-warning">
          Permanently deletes <strong>{project.title}</strong> and cascade-deletes all issues,
          pull requests, webhook deliveries, and review records. This cannot be undone.
        </p>
        <Field label={`Type "${project.slug}" or "${project.title}" to confirm`}>
          <input
            className="input"
            value={deleteConfirm}
            onChange={(event) => setDeleteConfirm(event.target.value)}
            autoComplete="off"
          />
        </Field>
        <MutationError mutation={remove} />
        <button
          type="button"
          className="btn btn-danger"
          disabled={!deleteAllowed || remove.isPending || save.isPending}
          onClick={() => {
            if (!deleteAllowed) return;
            if (!confirm(`Delete project "${project.title}" and all its data?`)) return;
            remove.mutate();
          }}
        >
          {remove.isPending ? "Deleting…" : "Delete project"}
        </button>
      </section>
    </FormScreen>
  );
}

function NewProjectScreen({
  onBack,
  onCreated,
}: {
  onBack: () => void;
  onCreated: (project: Project) => void;
}) {
  const client = useQueryClient();
  const create = useMutation({
    mutationFn: (payload: ProjectInput) => api<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
    onSuccess: async (project) => {
      await client.invalidateQueries({ queryKey: ["projects"] });
      onCreated(project);
    },
  });
  return (
    <FormScreen
      title="New project"
      subtitle="Create a workspace with its own issues, PRs, and webhook settings."
      onBack={onBack}
    >
      <form
        className="form-screen-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const slug = String(form.get("slug") || "").trim();
          const webhookUrl = String(form.get("webhookUrl") || "").trim();
          const labelFilter = String(form.get("labelFilter") || "").trim();
          const commentTrigger = String(form.get("commentTrigger") || "").trim();
          const baseUrl = String(form.get("baseUrl") || "").trim();
          create.mutate({
            title: String(form.get("title") || ""),
            ...(slug ? { slug } : {}),
            ...(webhookUrl ? { webhookUrl } : {}),
            ...(labelFilter ? { labelFilter } : {}),
            ...(commentTrigger ? { commentTrigger } : {}),
            ...(baseUrl ? { baseUrl } : {}),
            webhookEnabled: form.get("webhookEnabled") === "on",
          });
        }}
      >
        <Field label="Title">
          <input name="title" className="input" required autoFocus autoComplete="off" placeholder="Acme Todo" />
        </Field>
        <Field label="Slug (optional)">
          <input name="slug" className="input" autoComplete="off" placeholder="acme-todo" />
        </Field>
        <Field label="Callback URL (optional)">
          <input name="baseUrl" className="input" autoComplete="off" placeholder="http://127.0.0.1:8320" />
        </Field>
        <Field label="Webhook URL (optional)">
          <input name="webhookUrl" className="input" autoComplete="off" placeholder="http://127.0.0.1:8319/runs" />
        </Field>
        <Field label="Label filter (optional)">
          <input name="labelFilter" className="input" autoComplete="off" placeholder="trigger" />
        </Field>
        <Field label="Continuation command (optional)">
          <input name="commentTrigger" className="input" autoComplete="off" placeholder="/helix" />
        </Field>
        <label className="checkbox-row">
          <input name="webhookEnabled" type="checkbox" defaultChecked />
          <span>Enable webhooks</span>
        </label>
        <MutationError mutation={create} />
        <FormActions onCancel={onBack} busy={create.isPending} submitLabel="Create project" />
      </form>
    </FormScreen>
  );
}

function FormScreen({
  title,
  subtitle,
  onBack,
  children,
}: {
  title: string;
  subtitle: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <div className="form-screen">
      <header className="form-screen-header">
        <button type="button" className="btn btn-ghost form-screen-back" onClick={onBack}>
          <Icon name="chevron-left" /> Back
        </button>
        <div className="form-screen-heading">
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
      </header>
      <main className="form-screen-body">{children}</main>
    </div>
  );
}

function EmptyProjectsState({ onCreate }: { onCreate?: () => void }) {
  return (
    <main className="empty-projects">
      <div className="empty-state">
        <BrandMark />
        <p className="empty-title">No projects yet</p>
        <p className="empty-hint">{onCreate
          ? "Create your first project to start tracking issues and local pull requests."
          : "No projects are available. Ask someone with Issues write access to create one."}</p>
        {onCreate && <button type="button" className="btn btn-primary" onClick={onCreate}>
          <Icon name="plus" /> Create first project
        </button>}
      </div>
    </main>
  );
}

function AuthLoading() {
  return (
    <div className="auth-page">
      <div className="auth-card"><p>Resolving Acme identity…</p></div>
    </div>
  );
}

function Login({ error, onSignedIn }: { error?: string; onSignedIn: () => Promise<void> }) {
  const [message, setMessage] = useState(error ?? "");
  const login = useMutation({
    mutationFn: (credentials: { username: string; password: string }) =>
      api("/api/auth/session", { method: "POST", body: JSON.stringify(credentials) }),
    onSuccess: onSignedIn,
    onError: (loginError: Error) => setMessage(loginError.message),
  });
  return (
    <div className="auth-page">
      <form
        className="auth-card"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          login.mutate({
            username: String(form.get("username") ?? ""),
            password: String(form.get("password") ?? ""),
          });
        }}
      >
        <BrandMark />
        <div><p className="auth-eyebrow">Acme Identity</p><h1>Sign in to Acme Issues</h1></div>
        <Field label="Username">
          <input name="username" className="input" autoComplete="username" autoFocus required />
        </Field>
        <Field label="Password">
          <input name="password" className="input" type="password" autoComplete="current-password" required />
        </Field>
        {message && <p className="auth-error" role="alert">{message}</p>}
        <button className="btn btn-primary" type="submit" disabled={login.isPending}>
          {login.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

function Modal({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {children}
    </dialog>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

function DialogActions({
  onClose,
  busy,
  submitLabel,
}: {
  onClose: () => void;
  busy: boolean;
  submitLabel: string;
}) {
  return (
    <div className="dialog-actions">
      <button className="btn btn-ghost" type="button" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" type="submit" disabled={busy}>
        {busy ? "Saving…" : submitLabel}
      </button>
    </div>
  );
}

function FormActions({
  onCancel,
  busy,
  submitLabel,
}: {
  onCancel: () => void;
  busy: boolean;
  submitLabel: string;
}) {
  return (
    <div className="form-screen-actions">
      <button className="btn btn-ghost" type="button" onClick={onCancel}>Cancel</button>
      <button className="btn btn-primary" type="submit" disabled={busy}>
        {busy ? "Saving…" : submitLabel}
      </button>
    </div>
  );
}

function MutationError({
  mutation,
}: {
  mutation: { isError: boolean; error: Error | null };
}) {
  return mutation.isError ? <p className="field-help react-error">{mutation.error?.message}</p> : null;
}

function ReviewItems({
  title,
  items,
}: {
  title: string;
  items: { badge: string; title: string; body: string }[];
}) {
  return (
    <div>
      <h4>{title}</h4>
      <ul className="review-list">
        {items.map((item, index) => (
          <li
            className={`review-item ${title === "Checks" ? "check" : "finding"}-${item.badge}`}
            key={`${item.title}-${index}`}
          >
            <div><span className="review-badge">{item.badge}</span> <strong>{item.title}</strong></div>
            <p>{item.body}</p>
          </li>
        ))}
        {!items.length && <li className="review-empty">No {title.toLowerCase()}.</li>}
      </ul>
    </div>
  );
}

function MergeCommandPanel({
  commands,
  onCopy,
}: {
  commands: { shell: string; lines: string[] };
  onCopy: () => void;
}) {
  return (
    <div className="merge-command-panel">
      <div className="merge-command-head">
        <div>
          <h3>Or merge yourself</h3>
          <p>Paste this in a terminal if you prefer not to use the Merge button.</p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={async () => {
            await navigator.clipboard.writeText(commands.shell);
            onCopy();
          }}
        >
          Copy
        </button>
      </div>
      <pre className="merge-command">{commands.lines.join("\n")}</pre>
    </div>
  );
}

function EmptyIssue() {
  return (
    <div className="empty-state">
      <svg className="empty-illustration" viewBox="0 0 120 120" fill="none" aria-hidden="true">
        <rect x="18" y="30" width="84" height="64" rx="10" fill="#eef0f6" stroke="#d6dbe8" strokeWidth="2" />
        <path d="M18 44a10 10 0 0 1 10-10h64a10 10 0 0 1 10 10v6H18v-6Z" fill="#e2e6f0" />
        <circle cx="32" cy="42" r="3" fill="#c3cadd" />
        <circle cx="42" cy="42" r="3" fill="#c3cadd" />
        <rect x="32" y="62" width="40" height="6" rx="3" fill="#c3cadd" />
        <rect x="32" y="74" width="56" height="6" rx="3" fill="#d6dbe8" />
        <circle cx="88" cy="80" r="16" fill="#4f46e5" />
        <path d="M88 72v16M80 80h16" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <p className="empty-title">No issue selected</p>
      <p className="empty-hint">Pick an issue from the list, or create a new one to get started.</p>
    </div>
  );
}

function QueryError({ error }: { error: Error }) {
  return <p className="query-state react-error">{error.message}</p>;
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <rect width="32" height="32" rx="8" fill="#4f46e5" />
        <path
          d="M11 8v16M21 8v16M8 13h16M8 19h16"
          stroke="#fff"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

type IconName =
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "plus"
  | "refresh"
  | "search"
  | "settings"
  | "trash"
  | "zap";

function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    "chevron-down": <path d="m6 9 6 6 6-6" />,
    "chevron-left": <path d="m15 18-6-6 6-6" />,
    "chevron-right": <path d="m9 18 6-6-6-6" />,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    refresh: <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M6.1 8.3A7 7 0 0 1 18.5 7L20 12M4 12l1.5 5a7 7 0 0 0 12.4-1.3" /></>,
    search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.1A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.18.36.52.72 1 .9.3.12.64.18 1 .18h.1v4h-.1c-.36 0-.7.06-1 .18-.48.18-.82.54-1 .74Z" /></>,
    trash: <><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="m6 7 1 13h10l1-13" /><path d="M10 11v5M14 11v5" /></>,
    zap: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  };
  return (
    <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function parseLabels(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function positiveNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function syncAppUrl(params: {
  project: string | null;
  screen: "settings" | "new-project" | null;
  issue: number | null;
  pr: number | null;
}) {
  const search = new URLSearchParams();
  if (params.project) search.set("project", params.project);
  if (params.screen) search.set("screen", params.screen);
  if (!params.screen) {
    if (params.issue) search.set("issue", String(params.issue));
    else if (params.pr) search.set("pr", String(params.pr));
  }
  const qs = search.toString();
  const next = qs ? `${location.pathname}?${qs}` : location.pathname;
  const current = `${location.pathname}${location.search}`;
  if (current !== next) {
    history.replaceState(null, "", next);
  }
}
