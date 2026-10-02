# ADR 0010: one portal projection; identities only select a grant

**Status:** accepted and implemented (2026-10-01).
**Date:** 2026-10-01.
**Decision:** there is one portal-projection implementation. An external client
identity and an internal employee preview identity both select a portal grant
before projection runs. The grant selection is the only difference between the
two paths.

---

## The problem

Two projection implementations exist:

- `client-portal/client-portal.service.ts:getProjectOverview` — for external
  identities after grant lookup.
- `client-portal/client-portal.service.ts:getPortalPreview` — for internal
  employee preview, which explicitly skips grant selection.

`getPortalPreview` duplicates source predicates (task visibility, milestone
inclusion, file projection, comment filtering) that `getProjectOverview` also
owns. Every time a projection rule changes, it must be applied in two places.

BLD-00 D10 is explicit: "Preview and external detail use the same field
projection for a selected grant." The current two-path implementation
contradicts that decision.

The `client-portal-preview.spec.ts` and `client-portal-source-acl.spec.ts`
suites also diverge in coverage because they test different code paths for the
same intended behavior.

## The decision

One projection function owns the portal view: fields, capabilities, source
deletion behavior, ordering, and truncation. It accepts a resolved grant and an
actor.

Identity resolution is the caller's job:

- **External identity** — the `client-portal/` entry point looks up the grant
  from the session token, verifies status and expiry, and passes the grant to
  the projection.
- **Internal preview identity** — the `portal/` entry point requires a
  `build:portal:preview` permission, selects the grant the employee requests,
  and passes the same grant to the same projection.

Neither identity path may call a projection function that skips grant selection.
A preview for a project with no active grant returns 404; the frontend shows
"No portal published yet".

The owner module path is `backend/src/modules/build/client-portal/`. The portal
projection sub-module lives there. See the architecture contract
(`docs/specs/build/module/07-architecture-integrations-prd.md`) for the module
map.

## Consequences

**Parity by construction.** Projection rules live once. A changed field
projection is tested once and applies to both identities automatically.

**Preview must select a grant.** `getPortalPreview` cannot skip grant
resolution. If no grant exists for an internal preview, the caller creates a
synthetic preview grant scoped to the project or gets a 404. The projection
function does not receive `null` as a grant.

**Tests hit one seam.** `client-portal-preview.spec.ts` and
`client-portal-source-acl.spec.ts` converge to a single suite that exercises
`getPortalProjection` with different grant inputs.

**Expiry enforcement.** The shared projection path enforces
`expires_at IS NULL OR expires_at > now()` on the grant before executing, so
neither identity path can return a projection from an expired grant.

## The rule that holds

> Identities select a grant. The projection module owns the view. No path to a
> portal projection may bypass grant selection.

## Implementation

- `client-portal/portal-projection.ts` exports `buildPortalProjection`, the one
  projection. `client-portal/portal-projection.service.ts`
  (`PortalProjectionService`) exposes it to other modules.
- `client-portal/client-portal.service.ts` (preview) and
  `modules/portal/client/portal-client.service.ts` (external client) both
  select a grant, then call the same projection.
- `modules/portal/client/portal-client-projection-parity.spec.ts` proves the
  two identities get the same projection for the same grant.
