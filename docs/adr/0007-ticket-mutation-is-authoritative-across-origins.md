# ADR 0007: ticket mutation is authoritative across all origins

**Status:** accepted and implemented (2026-10-01).
**Date:** 2026-10-01.
**Decision:** every ticket mutation (manual, automation, git) routes through the
deep ticket-change module. Automation decides *when* a rule runs; the ticket
mutation owner decides *how* each change executes.

---

## The problem

`core/tickets/apply-ticket-change.ts` is the canonical mutation path: it
enforces per-project custom statuses, WIP limits, version CAS, and drives all
downstream effects (outbox event, activity log, notification dispatch,
automation fan-out). That invariant is sound for manual edits.

Automation (`core/automation/build-automation-actions.service.ts`,
`build-automation-runner.service.ts`) also writes tickets directly — updating
fields, assigning labels, and posting comments — outside of the canonical
mutation path. The same business change has different enforcement depending on
whether it arrived via the UI or an automation rule:

- WIP limits are not re-checked on automation-driven status moves.
- The version CAS is bypassed, so automation and a concurrent manual edit can
  produce split-brain ticket state.
- Downstream effects (outbox event → webhook fan-out, activity row) are
  duplicated or absent depending on the automation action type.

A third origin (git provider inbound events) would have the same problem if it
wrote tickets directly.

## The decision

The ticket-change module (`core/tickets/apply-ticket-change.ts`) is the sole
mutation owner. All origins call it:

- **Manual origin** — controllers call `applyTicketChange` directly.
- **Automation origin** — automation evaluates its rule and produces an
  `ApplyTicketChangeInput`; `applyTicketChange` executes the change. Automation
  retains ownership of: loop prevention (idempotent run guard),
  `registerAfterCommit` scheduling, and run history recording.
- **Git origin** — after durable receipt, the inbound-event consumer produces an
  `ApplyTicketChangeInput` and calls the same path.

No automation action may call `db.update(tickets, …)` or `db.insert(comments,
…)` directly. If automation needs a side-channel write (e.g., a label mapping
table), that write belongs to the module that owns the label mapping, called
through its exported service contract.

## Consequences

**Invariants apply universally.** WIP limits, version CAS, workflow guards, and
effect sequencing (outbox, activity, notification) run exactly once per
mutation regardless of origin.

**Automation owns timing, not shape.** `build-automation-runner.service.ts`
continues to own loop prevention, `registerAfterCommit` scheduling, and run
history. These are automation-specific concerns and do not belong in the
ticket-change module.

**Tests cross one seam.** A spec that exercises `applyTicketChange` with an
automation-originated payload proves that automation inherits all invariants.
There is no second test surface for automation-specific mutation behavior.

**Breaking change for direct automation DB writes.** Any automation action that
currently writes `tickets`, `ticket_comments`, or `ticket_label_mappings`
directly must be replaced with a call through the owning service. Existing
tests that mock those direct writes become vacuous — replace them with tests
that cross `applyTicketChange`.

## The rule that holds

> Automation chooses when a rule fires. The ticket-change module decides how
> every ticket mutation executes, regardless of origin.

## Implementation

- `core/automation/build-automation-actions.service.ts` runs every action as
  system job `build.automation.apply-action` (`common/auth/system-jobs.ts`),
  acting on behalf of the rule author.
- Status, priority and assignee changes call `updateTicket` on the
  `AUTOMATION_TICKET_CHANGE` token, bound in `core/projects.module.ts` to
  `ProjectsTicketsUpdateService`, which runs `applyTicketChange`. The executor
  reads the current version and passes it, so the CAS applies.
- Labels go through `ProjectsTicketLabelsService.addTicketLabel`; comments go
  through `ProjectsTicketCommentsService.addComment`.
- `project-access.ts` grants a system job project reach only when its ceiling
  covers `build:tickets:view`.
- The loop guard stays in the runner: the after-commit run re-enters the
  caller's `automationChainStorage` store, so `MAX_AUTOMATION_CHAIN_DEPTH`
  holds across automation-triggered changes.
