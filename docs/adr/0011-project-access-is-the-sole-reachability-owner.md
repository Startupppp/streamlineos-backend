# ADR 0011: project-access is the sole reachability owner

**Status:** accepted and implemented — reinforces ADR 0004 (2026-10-01).
**Date:** 2026-10-01.
**Decision:** `backend/src/modules/build/core/project-crud/project-access.ts`
is the only code that may decide whether an actor can reach a project. No other
module reconstructs a subset of that logic.

---

## The problem

A canonical implementation of project reachability exists:
`resolveProjectAccess` covers owner, manager, member, and team membership. It
reads from `build.project_members`, `build.project_team_members`,
`build.project_managers`, and `build.build_members`, and it is the path used
by `apply-ticket-change.ts` and `projects-query.service.ts`.

Four other Build modules reconstruct partial variants of the same check:

| Module | What it re-queries |
|---|---|
| `projects-write.service.ts` | Membership + owner check for project write ops |
| `projects-members.service.ts` | Membership check for member management |
| `projects-custom-states.service.ts` | Membership/manager check for state updates |
| `projects-budget.service.ts` | Project membership for budget visibility |

Each partial variant is a subset of the canonical check — but a subset that may
diverge as the reachability rules evolve. A new team-membership edge case added
to `project-access.ts` does not automatically propagate to the four copies.

ADR 0004 (auth facts resolve once per request) established the pattern of a
single fact resolved behind one owner. This ADR applies the same principle to
project reachability.

## The decision

`core/project-crud/project-access.ts` exports:

- `resolveProjectAccess` — full reachability check, returns role + hasAccess.
- `assertProjectAccess` — throws `ForbiddenException` (or 404 for cross-tenant)
  if the actor cannot reach the project.
- `assertProjectInOrg` — org-scoping check without member resolution.

Every Build module that needs to know whether an actor can reach a project calls
one of these three functions. No module may call `db.select()` against
`project_members`, `project_team_members`, `project_managers`, or
`build_members` to answer the reachability question independently.

Callers retain their operation-specific permission requirements. `assertProjectAccess`
answers "can the actor reach the project"; the caller checks "is the actor
allowed to perform this operation on the project" using their own permission
guard. Reachability and permission are separate steps.

The reachability result is per-request-cached via the standard cache-aside
pattern (`CacheService` with the actor, org, and project key) — the caller does
not cache it separately.

## Consequences

**Invariants propagate.** A change to team-membership logic in
`project-access.ts` propagates to all callers automatically. No partial copy
can drift.

**Regression path.** This ADR reveals that the four partial implementations
described above are regressions against the "project access once per request"
remediation that was previously applied. Fixing them does not reopen that
decision — it restores compliance with it.

**One conformance matrix.** An authz test suite that exercises
`resolveProjectAccess` via the canonical path covers every Build operation that
calls it. There is no need for a separate access-matrix test per service.

**Import discipline.** Every new Build service that needs project reachability
imports from `../project-crud/project-access` (re-exported via
`core/index.ts`). A grep for `project_members` or `project_team_members`
outside of `project-access.ts`, `project-crud/`, and migration files is the
conformance signal.

## The rule that holds

> `project-access.ts` is the only code in Build that decides whether an actor
> can reach a project. Callers add their own operation permission on top; they
> do not re-query the reachability tables.

## Implementation

- `project-access.ts` exports `assertCanManageProject`; members, custom states,
  budget, automations and timesheets call it instead of rebuilding the manager
  check.
- Portfolios, programs and whiteboards call `assertProjectInOrg` instead of
  private copies; the whiteboard alias re-export is gone.
- System-job principals reach a project only when their ceiling covers
  `build:tickets:view`.
- `project-access-conformance.spec.ts` pins the decision table.
