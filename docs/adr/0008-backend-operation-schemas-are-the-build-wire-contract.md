# ADR 0008: backend operation schemas are the single Build wire contract

**Status:** accepted — written from the architecture review (2026-10-01).
**Date:** 2026-10-01.
**Decision:** the Zod schemas in `backend/src/modules/build/core/dto/` are the
authoritative wire shape. The OpenAPI document and the frontend adapter files
are generated from them; no parallel hand-written frontend Zod schema may
describe the same request or response.

---

## The problem

Three independent owners currently describe the Build wire shape:

1. **Backend Zod schemas** (`core/dto/*response.schemas.ts`) — declare the
   canonical request, response, and error shape.
2. **Generated OpenAPI document** (`backend/openapi.json`,
   `frontend/contracts/openapi.json`) — a point-in-time snapshot generated from
   the backend schemas. When it is stale, the frontend cannot call new routes.
3. **Hand-written frontend Zod schemas** (`frontend/hooks/api/build/
   build-tickets-*-schema.ts`, `build-project-schema.ts`, etc.) — duplicated
   descriptions of the same wire shape; they drift from the backend independently.

Observed drift: `healthBreakdown.openTickets` was present on the backend but
missing from the frontend contract, causing `applyContract` to throw on every
`/build/:projectId` load. The ticket `version` field was absent from the backend
contract while the frontend required it. Each drift required a manual
cross-repo fix.

## The decision

The backend operation schemas are the single source of truth for Build wire
shapes:

- `@ResponseSchema(…)` decorators on Build controllers reference schemas in
  `core/dto/`.
- `pnpm openapi:generate` produces `backend/openapi.json` from those schemas.
- `frontend/contracts/openapi.json` is vendored from the backend artifact;
  `check:contract-vendor` gates the copy.
- Frontend Build hooks import their types from the vendored contract or from
  generated adapter files derived from it. A frontend file that re-declares a
  field present in the backend schema is a parity violation and must be removed.

Deliberate frontend compatibility decoding (e.g., treating a missing field as
optional to preserve backward compat during a rolling deploy) is allowed and
stays local to the adapter layer. It is not a parallel schema declaration — it
is a known-gap decoder in a named file.

## Consequences

**One wire owner.** A Build response field is defined once, in the backend
schema. `check:contract-parity` and `check:contract-vendor` are the
enforcement gates.

**Stale vendored contract = invisible routes.** Any route added to the backend
after the last vendoring is unreachable from the frontend until the contract is
regenerated and vendored. `check:openapi-fresh` (which runs `openapi:generate`
and diffs) detects this; the gate must run before release.

**Adapter isolation.** Compatibility shims live in a single named file per
Build sub-domain, never inline in a component. This makes drift observable
with a targeted grep.

**No forward references.** A `z.lazy` or dynamic import that hides a schema
from the registry is a contract violation; `lazyContract` dynamic imports are
invisible to import greps and must not be used for core Build schemas.

## The rule that holds

> The backend Zod schema is the wire authority. Nothing in the frontend may
> declare a Build request or response shape that the backend did not first
> define.
