# Acme Issues agent guide

Acme Issues is the local issue and pull-request management surface for Helix. It is not the target application Helix should modify during an end-to-end workflow test.

## Related projects

| Project | Local path | Responsibility |
|---|---|---|
| Primer | `~/Desktop/acme/primer` | Knowledge product and fictional Acme evidence corpus; outside the Issues → Helix runtime loop. |
| Prelude | `~/Desktop/acme/prelude` | Project inception drafting and bootstrap artifact export for Helix empty-workspace bootstrap. |
| Helix | `~/Desktop/acme/helix` | Agent workflow control plane that receives work and orchestrates changes. |
| Acme Issues | `~/Desktop/acme/acme-issues` | Local issue and PR management surface that triggers Helix and receives callbacks. |
| Acme Projects | `~/Desktop/acme/acme-projects` | Standalone feature-idea and collaboration board for existing Helix repos; can manually create non-triggering issues here. |
| Acme Todo | `~/Desktop/acme/acme-todo` | Disposable target application used for agent implementation and verification. |

Existing-repo flow: Acme issue → Helix implementation → Acme local PR → Helix independent PR review → human merge record. Primer shares the fictional Acme context but is not in that runtime path.

Manual feature handoff: Acme Projects ready card → linked issue labeled `acme-projects`; a human adds the configured trigger label here to start Helix. Automatic trigger and card lifecycle callbacks remain planned. Acme Projects will not call Helix directly; see [`docs/workflow-model.md`](./docs/workflow-model.md).

New-project inception belongs to Prelude. Prelude does not create issues or call Helix today; Helix consumes its exported artifacts via empty-workspace bootstrap.

## Working rules

- Preserve SQLite issue, comment, delivery, Helix-run lineage, local PR, and review-revision behavior.
- Keep webhook retries and continuation event identities deterministic.
- **Address feedback** on `changes_requested` / `blocked` PRs continues the
  latest completed Helix run for the linked issue (same continuation contract
  as `/helix`), with review findings as the instruction. Do not invent a
  same-run resume path.
- PR readiness is valid only for the current stored head SHA. Retain stale review history without applying its decision.
- Acme Issues is the human-facing PR UI; Helix owns specialist execution and readiness policy. Prefer Helix (`POST /local-prs/merge`) for human-initiated local merges so Issues does not need a reliable repository path; keep copyable git commands and same-machine local merge as fallbacks. Never auto-merge without an explicit human action.
- Preserve the planned boundary that Acme Projects owns feature intent while
  Acme Issues owns the generated implementation attempt and PR lifecycle.
- Do not add GitHub as a requirement for the local webhook loop.
- Keep callbacks unauthenticated only while the server remains a local-development harness.
- Before committing cross-cutting changes, run `npm run verify` (typecheck, test, and build).
