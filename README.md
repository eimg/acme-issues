# Acme Issues

A small, self-contained issue and local pull-request manager. Issues, Git-backed PR identities, SHA-bound review history, findings, and checks live in SQLite.

Pairs naturally with [Helix](https://github.com/eimg/helix) for local agent-driven workflows — no GitHub account required.

## Acme development testbed

The Acme suite is an executable reference architecture, not an all-inclusive platform or a universal prescription. Its local-first, independently runnable products and replaceable integration seams let subject-matter experts inspect working patterns and adapt the parts that fit their organization.

Acme Issues is one of the related projects. They remain separate products with separate responsibilities.

| Project | Role |
|---|---|
| **[Acme Identity](https://github.com/eimg/acme-identity)** | Suite auth; Issues resolves principals and enforces capability permissions. |
| **[Primer](https://github.com/eimg/primer)** | Knowledge product and fictional Acme evidence corpus; not currently part of the Issues → Helix runtime loop. |
| **[Prelude](https://github.com/eimg/prelude)** | Project inception workspace; exports bootstrap artifacts for Helix empty-workspace bootstrap. |
| **[Helix](https://github.com/eimg/helix)** | Agent workflow control plane that receives work and orchestrates changes. |
| **[Acme Issues](https://github.com/eimg/acme-issues)** | Local issue and PR management surface that triggers Helix and receives callbacks. |
| **[Acme Projects](https://github.com/eimg/acme-projects)** | Standalone feature-idea and collaboration board for existing Helix repos; can manually create non-triggering issues here. |
| **[Acme Todo](https://github.com/eimg/acme-todo)** | Disposable target application used for agent implementation and verification. |

Existing-repo exercise: Acme Issues sends a work item to Helix, which works on Acme Todo. Primer develops the separate knowledge side of the same fictional Acme context.

Current manual feature handoff: a ready Acme Projects card can create a thin
linked issue here with the `acme-projects` label via the nested project issues
API (`POST /api/projects/:ref/issues`). It does not include `trigger`;
a human adds the configured trigger label to start the existing Acme Issues →
Helix flow. Automatic triggering and project-card lifecycle callbacks remain
planned. Acme Projects will not call Helix directly; see
[`docs/workflow-model.md`](./docs/workflow-model.md).

New-project inception belongs to Prelude, which exports bootstrap artifacts for
Helix empty-workspace bootstrap (`helix bootstrap`) and does not call Acme Issues or Helix today.

![Acme Issues](https://i.imgur.com/icyJMPP.jpeg)

## Companion project: [Helix](https://github.com/eimg/helix)

This tracker is built to pair with **[Helix](https://github.com/eimg/helix)** — an agent control plane that runs implementation specialists and an independent local PR-review workflow.

| Project | Role |
|---------|------|
| **acme-issues** (this repo) | Human-facing issue and local PR management; stores review evidence and merge records |
| **[Helix](https://github.com/eimg/helix)** | Implements issues, then independently reviews exact PR head SHAs |

```
issue ──POST /runs──► Helix planner → dev self-check → committed feature branch
  ▲                                                     │
  │                                                     ▼
  │                                          Acme local PR (draft)
  │                                                     │
  │                          POST /pr-reviews────────────┘
  │                                                     ▼
  └──── exact-SHA evidence callback ◄──── Helix reviewer + verifier
```

No GitHub account or `gh` CLI required for this loop.

## Pull request review lifecycle

Acme Issues is the durable human-facing side of the review boundary:

1. A trusted producer registers a Git-backed PR with its repository path, base branch/SHA, head branch/SHA, author, origin, and optional linked issue. Helix normally supplies this after a successful implementation run.
2. A human requests review. Acme Issues sends the immutable PR identity and an idempotent callback identity to Helix’s independent `/pr-reviews` workflow.
3. Helix runs its reviewer and verifier against that exact head SHA, then returns lifecycle events, findings, executed checks, summary, and one of `ready_to_merge`, `changes_requested`, or `blocked`.
4. Acme Issues stores every review revision, but applies a decision to the current PR only when the returned head SHA still matches. Changing the head resets readiness to `draft`; older evidence remains visible as history.
5. `ready_to_merge` does not auto-merge Git. Use **Merge into \<base\>** to perform the local merge from the UI, or copy the shown shell commands and merge yourself, then **Record only** if needed. Recording merge closes the linked issue.

This boundary lets the same review workflow accept Helix-created PRs and PRs registered by another trusted producer without making GitHub a dependency. Registered repositories and their verification commands are currently assumed trusted; the local harness is not a sandbox for hostile contributions.

## Requirements

- Node.js 20.19 or newer

## Install

```bash
git clone https://github.com/eimg/acme-issues.git
cd acme-issues
npm install
npm run build    # optional; dev mode compiles on the fly
npm link         # optional; exposes `acme-issues` CLI
```

## Getting started

### Standalone (tracker only)

```bash
npm run dev
# → http://127.0.0.1:8320/
```

Open the project title in the header to select or create a project, then open
**Settings** for that project’s webhook URL, callback URL, and label filter.
Create issues from the UI or nested project API.

### Authentication and permissions

Acme Issues defaults to `ACME_AUTH_MODE=off`, which resolves an admin development
principal locally. This keeps standalone development and existing feature tests
independent of Acme Identity. For real sign-in and role checks, start both apps:

```bash
# in ../acme-identity
ACME_AUTH_MODE=local npm run dev

# in this repository
ACME_AUTH_MODE=local ACME_IDENTITY_URL=http://127.0.0.1:8316 npm run dev
```

The browser signs in through Acme Issues, which forwards the session request to
Identity. `issues.read` is read-only; `issues.write` can both read and mutate.
The UI and API check permission strings rather than role names, so later custom
roles work without code changes. The built-in `viewer` is read-only, while
`member`, `operator`, and `admin` can mutate Issues data.

The rightmost account menu keeps identity separate from project navigation. It
shows the current principal and auth mode, links to the Identity account when
local auth supplies that URL, and contains sign-out. Because the local suite
shares a host-only session cookie across ports, signing out invalidates the
central session for the other Identity-backed apps on the same hostname.

API clients and trusted producers may send an Identity service token as
`Authorization: Bearer svc_…`. The local Helix callback at
`POST /api/webhooks/helix` requires `issues.write` like other mutations. In
`ACME_AUTH_MODE=local`, configure Helix with a service token through
`HELIX_ISSUES_TOKEN`; browser cookies are not required for machine callbacks.

### Recommended: Helix integration

Run both services side by side.

**Terminal 1 — Helix on your target repo**

```bash
git clone https://github.com/eimg/helix.git
cd helix && npm install && npm run build && npm link

cd your-project
helix init --preset typescript
cp .env.example .env   # set OPENROUTER_API_KEY + HELIX_MODEL
helix serve
# → http://127.0.0.1:8319/
```

**Terminal 2 — acme-issues**

```bash
git clone https://github.com/eimg/acme-issues.git
cd acme-issues && npm install
npm run dev
# → http://127.0.0.1:8320/
```

**Configure project settings** (`http://127.0.0.1:8320/` — create or select a
project from the header title, then **Settings**):

| Setting | Value |
|---------|-------|
| Callback URL | `http://127.0.0.1:8320` (this Issues base URL for Helix callbacks) |
| Webhook URL | `http://127.0.0.1:8319/runs` |
| Label filter | `trigger` (default) |
| Continuation comment command | `/helix` (default) |
| Webhooks enabled | on |

Create an open issue with the `trigger` label (or add the label to an existing issue). Acme Issues delivers a webhook and Helix starts an implementation run. When the Dev leaves a clean committed feature branch, Helix registers it here as a draft local PR. The linked issue remains **in progress**.

Open the **Pull requests** view to inspect the repository, branches, exact base/head SHAs, diff, review evidence, and history. Request review to run Helix’s independent reviewer and verifier concurrently. Only a structured decision for the current head SHA can set `ready_to_merge`; a head update resets the PR to `draft` and makes older callbacks stale.

Helix never performs an automatic merge. After review passes, **Merge into \<base\>** asks Helix (`POST /local-prs/merge`) to merge the reviewed head in the workspace Helix owns, then records the result and closes the linked issue. Copyable shell commands are always shown (using Helix’s workspace path when Issues cannot see the recorded path). **Record only** remains available when you already merged outside the UI.

When review returns `changes_requested` or `blocked`, **Address feedback** asks Helix to continue the linked implementation run (same lineage as `/helix`), with the review findings as the continuation instruction. That is a fresh linked child run in Helix history — not a resumed session. After Helix pushes new commits, update the PR head if needed and **Request review** again.

The UI intentionally does not create pull requests or select repositories.
Helix supplies the repository, branch, and exact SHA identity when it registers
completed work via the flat tracker contract (`POST/PATCH /api/pull-requests`).
Nested `/api/projects/:ref/pull-requests` remains for the Issues UI and other
producers that already know the project.

The current localhost harness assumes registered repositories and branches are trusted. Diff reading and Helix verification operate on local paths, and verification is not container-sandboxed yet.

After completion, reopen the issue or add a comment such as `/helix also cover the regression case`. The tracker uses the latest completed Helix run recorded from callbacks and sends a linked continuation request. Ordinary comments do not trigger Helix.

Full Helix setup and config: [github.com/eimg/helix](https://github.com/eimg/helix#getting-started).

## Default project configuration

Each project stores its own settings (formerly global):

| Setting | Default |
|---------|---------|
| Callback URL (`baseUrl`) | `http://127.0.0.1:8320` |
| Webhook URL | *(empty — configure in Settings)* |
| Label filter | `trigger` |
| Continuation comment command | `/helix` |
| Webhooks enabled | `false` |

Server port and data directory remain process-level:

| Setting | Default |
|---------|---------|
| Port | `8320` |
| Data directory | `./data/` (override with `ACME_ISSUES_DATA_DIR`) |

## Webhook behavior

When webhooks are enabled and a URL is set, delivery fires on:

1. **Issue created** — open issue includes the label filter
2. **Label added** — filter label added to an open issue
3. **Issue reopened** — if a completed Helix run is known, continue it; otherwise start an initial run
4. **Command comment** — a user comment beginning with the configured command continues the latest completed run
5. **Manual** — **Send webhook** button or `POST /api/projects/:ref/issues/:id/trigger`
6. **Address feedback** — on a `changes_requested` / `blocked` PR, continues the latest completed Helix run for the linked issue with review findings (`POST /api/projects/:ref/pull-requests/:id/address-feedback`)

Outbound payload (includes correlation for Helix callbacks):

```json
{
  "title": "Fix login",
  "body": "Empty password returns 500",
  "labels": ["trigger", "bug"],
  "external": {
    "trackerUrl": "http://127.0.0.1:8320",
    "issueId": 7,
    "projectId": 1,
    "projectSlug": "acme-todo"
  }
}
```

Headers: `X-Issues-Issue-Id`, `X-Issues-Project-Id`, `X-Issues-Source`, `X-Issues-Reason`.
Helix’s stable contract only requires `trackerUrl` + `issueId` (and the flat
PR/callback paths); project fields are optional extras Issues may send.

Issue deliveries retry up to 3 times and appear in **Webhook deliveries**. PR review requests are sent directly to the Helix `/pr-reviews` endpoint derived from the configured `/runs` URL.

## Helix callbacks (inbound)

Helix can notify this tracker as a run progresses. Endpoint: `POST /api/webhooks/helix`

**`run.completed`** (sent by Helix today when a run finishes):

```
POST /api/webhooks/helix
X-Helix-Event: run.completed

{
  "event": "run.completed",
  "run": { "id": "...", "status": "done", "startedAt": ..., "finishedAt": ... },
  "issue": { "id": 7, "title": "Fix login" }
}
```

→ issue status `closed` when there is no active local PR; otherwise it remains `in_progress` awaiting review and human merge

The callback may include `parentRunId` and `rootRunId`. acme-issues stores this lineage and uses the newest completed run when it delivers a reopen or command-comment continuation.

**`run.started`** (supported by this tracker; Helix does not send it yet):

```
POST /api/webhooks/helix
X-Helix-Event: run.started

{
  "event": "run.started",
  "run": { "id": "...", "status": "running", "startedAt": ... },
  "issue": { "id": 7, "title": "Fix login" }
}
```

→ issue status `in_progress` + Helix comment

In local auth mode, callbacks use bearer service auth. Set `ACME_HELIX_TOKEN` for
Issues requests to Helix and `ACME_PROJECTS_TOKEN` for lifecycle callbacks to
Projects. Off mode remains zero-configuration for standalone development.
The tokens are sent only to `ACME_TRUSTED_HELIX_ORIGINS` and
`ACME_TRUSTED_PROJECTS_ORIGINS` respectively (defaults: the local `8319` and
`8321` origins). Changing a project or callback URL cannot redirect a service
credential to another origin.

### Local PR review callbacks

Helix sends `pr.review.started` and `pr.review.completed` to the same callback endpoint. Every result carries the reviewed `headSha`. Acme Issues stores all review revisions but updates current PR readiness only when that SHA still matches:

```json
{
  "event": "pr.review.completed",
  "review": {
    "id": "...",
    "status": "completed",
    "headSha": "abc123...",
    "decision": "ready_to_merge",
    "summary": "Reviewer and verifier passed.",
    "findings": [],
    "checks": [
      { "name": "npm test", "status": "passed", "summary": "Passed." }
    ]
  },
  "pullRequest": { "id": 4 }
}
```

## API

`:projectRef` is a project id or unique slug.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/projects` | List projects |
| `POST` | `/api/projects` | Create project (`title` required; optional `slug` + settings) |
| `GET` | `/api/projects/:projectRef` | Get project |
| `PATCH` | `/api/projects/:projectRef` | Update project title, slug, or settings |
| `DELETE` | `/api/projects/:projectRef` | Delete project (cascades issues, PRs, deliveries, reviews) |
| `GET` | `/api/projects/:projectRef/helix` | Probe Helix target (`…/health` from webhook URL): `online` / `offline` / `unconfigured` |
| `GET` | `/api/projects/:projectRef/issues` | List issues (`?status=open\|in_progress\|closed`, `?label=`, `?limit=`, `?offset=`) |
| `POST` | `/api/projects/:projectRef/issues` | Create issue |
| `GET` | `/api/projects/:projectRef/issues/:id` | Get issue |
| `PATCH` | `/api/projects/:projectRef/issues/:id` | Update issue |
| `DELETE` | `/api/projects/:projectRef/issues/:id` | Delete issue |
| `GET` | `/api/projects/:projectRef/issues/:id/comments` | List comments |
| `POST` | `/api/projects/:projectRef/issues/:id/comments` | Create comment (`body` required; optional `author`) |
| `PATCH` | `/api/projects/:projectRef/issues/:issueId/comments/:commentId` | Update comment (`body` and/or `author`) |
| `DELETE` | `/api/projects/:projectRef/issues/:issueId/comments/:commentId` | Delete comment |
| `POST` | `/api/projects/:projectRef/issues/:id/trigger` | Manual webhook delivery |
| `GET` | `/api/projects/:projectRef/pull-requests` | List local PRs (`?status=` optional) |
| `POST` | `/api/pull-requests` | Helix soft contract: create PR; project resolved from `issueId` |
| `GET` | `/api/pull-requests/:id` | Helix/UI soft contract: fetch PR + owning project for `?pr=` deep-links |
| `PATCH` | `/api/pull-requests/:id` | Helix soft contract: update PR; project resolved from PR id |
| `POST` | `/api/projects/:projectRef/pull-requests` | Register a PR in a known project (Issues UI / other producers; Helix uses the flat routes above) |
| `DELETE` | `/api/projects/:projectRef/pull-requests` | Clear all local PR history and reviews for the project |
| `GET` | `/api/projects/:projectRef/pull-requests/:id` | Get PR identity plus review history |
| `DELETE` | `/api/projects/:projectRef/pull-requests/:id` | Delete one local PR and its reviews |
| `GET` | `/api/projects/:projectRef/pull-requests/:id/diff` | Read the recorded base-to-head Git diff |
| `POST` | `/api/projects/:projectRef/pull-requests/:id/merge` | Human-initiated local Git merge of a `ready_to_merge` PR |
| `PATCH` | `/api/projects/:projectRef/pull-requests/:id` | Update head identity or record `draft`, `merged`, or `closed` |
| `POST` | `/api/projects/:projectRef/pull-requests/:id/review` | Request independent Helix PR review |
| `POST` | `/api/projects/:projectRef/pull-requests/:id/address-feedback` | Continue Helix run from PR review feedback |
| `GET` | `/api/projects/:projectRef/webhooks/deliveries` | Delivery log |
| `DELETE` | `/api/projects/:projectRef/webhooks/deliveries/:id` | Remove one delivery log |
| `DELETE` | `/api/projects/:projectRef/webhooks/deliveries` | Clear project delivery logs |
| `POST` | `/api/webhooks/helix` | Inbound Helix callbacks (resolves project via issue/PR id) |

`GET /api/projects/:projectRef/issues` returns `{ items, total, limit, offset }` (default `limit` 25).

Deep links use `?project=<slug>&issue=<id>` or `?pr=<id>` (Helix’s flat PR
link; Issues resolves the owning project). Nested `?project=<slug>&pr=<id>`
still works. Project settings and new-project use `?project=<slug>&screen=settings`
and `?screen=new-project`.

Issue status values: `open`, `in_progress`, `closed`.

Pull-request status values: `draft`, `reviewing`, `changes_requested`, `blocked`, `ready_to_merge`, `merged`, `closed`.

## Optional Steering notifications

Set `ACME_STEERING_URL` to publish issue, Helix-run, and pull-request lifecycle transitions to Acme Steering. In shared local-auth mode, set a scoped `ACME_STEERING_TOKEN` with `steering.notify.issues`. Delivery is best-effort after Issues commits its authoritative state. A trigger-eligible issue can open an implementation decision projection; a manual trigger or later lifecycle callback reconciles it. Merge remains a human action owned by Acme Issues.

Issues accepts `issues.trigger_implementation` at `POST /api/steering/actions`. The caller needs the action-specific `issues.steering.trigger` permission; Issues reloads the issue, validates the expected revision, delivers through its configured Helix adapter, and records `in_progress` only after Helix accepts the trigger. Merge is intentionally not exposed through this contract.

Every Steering disposition is independently accepted at `POST /api/steering/decisions` with `issues.steering.receive`, recorded in Issues' durable decision ledger, and appended once as a system comment on the issue. The ledger is also queryable at `GET /api/steering/decisions`. Receipt does not change issue, delivery, run, or pull-request state. Issues owns the deterministic response to reject, request revision, defer, or escalation; approval may separately invoke the narrow trigger action above.

## Development

The web interface is served at `/`.

```bash
npm run dev           # serve with auto-restart; UI is served from web/ over HMR
npm run dev:web       # standalone Vite development server; proxies /api to port 8320
npm run typecheck
npm test
npm run build
npm run verify        # typecheck + test + build
```

## Technology

- TypeScript and Node.js
- Express
- SQLite through `better-sqlite3`
- React and TanStack Query
- Vite

## License

[MIT](./LICENSE)
