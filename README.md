# Acme Issues

A small, self-contained issue and local pull-request manager. Issues, Git-backed PR identities, SHA-bound review history, findings, and checks live in SQLite.

Pairs naturally with [Helix](https://github.com/eimg/helix) for local agent-driven workflows — no GitHub account required.

## Acme development testbed

Acme Issues is one of six related projects. They remain separate products with separate responsibilities.

| Project | Role |
|---|---|
| **[Primer](https://github.com/eimg/primer)** | Knowledge product and fictional Acme evidence corpus; not currently part of the Issues → Helix runtime loop. |
| **[Prelude](https://github.com/eimg/prelude)** | Project inception workspace; exports bootstrap artifacts for Helix empty-workspace bootstrap. |
| **[Helix](https://github.com/eimg/helix)** | Agent workflow control plane that receives work and orchestrates changes. |
| **[Acme Issues](https://github.com/eimg/acme-issues)** | Local issue and PR management surface that triggers Helix and receives callbacks. |
| **[Acme Projects](https://github.com/eimg/acme-projects)** | Standalone feature-idea and collaboration board for existing Helix repos; can manually create non-triggering issues here. |
| **[Acme Todo](https://github.com/eimg/acme-todo)** | Disposable target application used for agent implementation and verification. |

Existing-repo exercise: Acme Issues sends a work item to Helix, which works on Acme Todo. Primer develops the separate knowledge side of the same fictional Acme context.

Current manual feature handoff: a ready Acme Projects card can create a thin
linked issue here with the `acme-projects` label. It does not include `trigger`;
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

Open **Settings** to set your webhook URL and label filter, then create issues from the UI or API.

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

**Configure Settings** (`http://127.0.0.1:8320/`):

| Setting | Value |
|---------|-------|
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
completed implementation work. The registration API retains the same generic
contract so another trusted producer can integrate later without changing the
review lifecycle.

The current localhost harness assumes registered repositories and branches are trusted. Diff reading and Helix verification operate on local paths, and verification is not container-sandboxed yet.

After completion, reopen the issue or add a comment such as `/helix also cover the regression case`. The tracker uses the latest completed Helix run recorded from callbacks and sends a linked continuation request. Ordinary comments do not trigger Helix.

Full Helix setup and config: [github.com/eimg/helix](https://github.com/eimg/helix#getting-started).

## Default configuration

| Setting | Default |
|---------|---------|
| Port | `8320` |
| Webhook URL | *(empty — configure in Settings)* |
| Label filter | `trigger` |
| Continuation comment command | `/helix` |
| Webhooks enabled | `false` |
| Data directory | `./data/` (override with `ACME_ISSUES_DATA_DIR`) |

## Webhook behavior

When webhooks are enabled and a URL is set, delivery fires on:

1. **Issue created** — open issue includes the label filter
2. **Label added** — filter label added to an open issue
3. **Issue reopened** — if a completed Helix run is known, continue it; otherwise start an initial run
4. **Command comment** — a user comment beginning with the configured command continues the latest completed run
5. **Manual** — **Send webhook** button or `POST /api/issues/:id/trigger`
6. **Address feedback** — on a `changes_requested` / `blocked` PR, continues the latest completed Helix run for the linked issue with review findings (`POST /api/pull-requests/:id/address-feedback`)

Outbound payload (includes correlation for Helix callbacks):

```json
{
  "title": "Fix login",
  "body": "Empty password returns 500",
  "labels": ["trigger", "bug"],
  "external": {
    "trackerUrl": "http://127.0.0.1:8320",
    "issueId": 7
  }
}
```

Headers: `X-Issues-Issue-Id`, `X-Issues-Source`, `X-Issues-Reason`.

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

Callbacks use no auth — intended for local development.

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

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/issues` | List issues (`?status=open\|in_progress\|closed`, `?label=`, `?limit=`, `?offset=`) |
| `POST` | `/api/issues` | Create issue |
| `GET` | `/api/issues/:id` | Get issue |
| `PATCH` | `/api/issues/:id` | Update issue |
| `DELETE` | `/api/issues/:id` | Delete issue |
| `GET` | `/api/issues/:id/comments` | List comments |
| `POST` | `/api/issues/:id/comments` | Create comment (`body` required; optional `author`) |
| `PATCH` | `/api/issues/:issueId/comments/:commentId` | Update comment (`body` and/or `author`) |
| `DELETE` | `/api/issues/:issueId/comments/:commentId` | Delete comment |
| `POST` | `/api/issues/:id/trigger` | Manual webhook delivery |
| `GET` | `/api/pull-requests` | List local PRs (`?status=` optional) |
| `POST` | `/api/pull-requests` | Register a Git-backed PR from Helix or another trusted producer |
| `DELETE` | `/api/pull-requests` | Clear all local PR history and reviews |
| `GET` | `/api/pull-requests/:id` | Get PR identity plus review history |
| `DELETE` | `/api/pull-requests/:id` | Delete one local PR and its reviews |
| `GET` | `/api/pull-requests/:id/diff` | Read the recorded base-to-head Git diff |
| `POST` | `/api/pull-requests/:id/merge` | Human-initiated local Git merge of a `ready_to_merge` PR |
| `PATCH` | `/api/pull-requests/:id` | Update head identity or record `draft`, `merged`, or `closed` |
| `POST` | `/api/pull-requests/:id/review` | Request independent Helix PR review |
| `GET` | `/api/webhooks/deliveries` | Delivery log |
| `DELETE` | `/api/webhooks/deliveries/:id` | Remove one delivery log |
| `DELETE` | `/api/webhooks/deliveries` | Clear all delivery logs |
| `GET` | `/api/config` | Read settings |
| `PATCH` | `/api/config` | Update settings |

`GET /api/issues` returns `{ items, total, limit, offset }` (default `limit` 25).

Issue status values: `open`, `in_progress`, `closed`.

Pull-request status values: `draft`, `reviewing`, `changes_requested`, `blocked`, `ready_to_merge`, `merged`, `closed`.

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
