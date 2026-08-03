# Intended Acme Projects workflow

**Status:** Acme Projects can create a non-triggering issue through the existing
Acme Issues API, and authenticated lifecycle callbacks project accepted runs,
PR creation, and human-recorded merges back to the source card. Adding the
configured trigger label remains an explicit human action.

This document covers the existing-repository feature path. Brand-new project
inception belongs to **Prelude**, which drafts freeform docs and exports
bootstrap artifacts for Helix empty-workspace bootstrap; Prelude does not create
Acme Issues records today.

Acme Issues remains the single implementation and pull-request intermediary
between Acme Projects and Helix. Acme Projects will not trigger Helix directly.

```text
Acme Projects card
  → human marks the card Ready
  → human selects Submit as issue
  → Acme Projects requests a linked implementation issue from Acme Issues
  → human adds the trigger label in Acme Issues
  → Acme Issues triggers Helix in the project repository
  → accepted Helix run moves the source card to In progress
  → Helix registers the resulting PR in Acme Issues
  → PR creation moves the source card to In review
  → human-recorded merge closes the issue and moves the source card to Done
```

Actual bugs and concrete operational issues may continue to enter Acme Issues
directly. Feature requests and ideas begin in Acme Projects so their discussion,
decisions, open questions, and acceptance notes can mature before execution.

## Implementation issue boundary

The Acme Issues record generated from a ready project card is a thin execution
envelope, not a second feature record. It should carry:

- a stable source-project and source-card reference;
- a concise implementation snapshot;
- acceptance notes;
- the inherited project repository identity;
- idempotent request and callback identities.

The project card remains authoritative for feature intent and collaboration.
Acme Issues owns the concrete implementation attempt, Helix-run lineage,
continuations, PR identity, review history, and human merge record.

One project card may create multiple sequential implementation issues and PRs.
The current integration permits only one active implementation attempt per
card, but the identity model does not equate a card with an issue.

## Trigger and state semantics

`Ready` is an eligibility and handoff boundary in Acme Projects. The default
integration is manual: the user selects **Submit as issue** on a ready card.
Acme Projects creates the issue through the Acme Issues nested project API with
`acme-projects`, but without the configured trigger label. A human adds that
label here when ready. Optional Acme Steering may request the same trigger through
`issues.trigger_implementation`; the current reference policy keeps it human-required.
The card moves to `In progress` only after Helix accepts a run, then Issues projects
PR registration and completion back to `In review` and `Done`.

A later organization-specific Steering policy may automatically authorize the
trigger. Failed issue creation or run submission leaves the card `Ready` and
requires an explicit retry; automatic behavior must not create a retry loop.

The intended state projection is:

| Acme Projects state | Required external fact |
|---|---|
| `Ready` | Feature intent is eligible; no accepted run is required |
| `In progress` | A linked issue exists and Helix accepted a run |
| `In review` | Helix registered a linked PR in Acme Issues |
| `Done` | A human recorded the PR merge in Acme Issues |

These are directional lifecycle projections, not shared mutable status fields.
Arbitrary issue edits must not rewrite project intent, and project-card
discussion must not be copied into issue comments.
