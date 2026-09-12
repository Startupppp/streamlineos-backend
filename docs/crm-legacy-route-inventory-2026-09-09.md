# CRM legacy route inventory — leads, contacts, clients

**CRM-P1-15.** Ticket: *"Dead unused legacy lead/contact/client routes inventory
+ prune only routes with zero FE callers (do not unmount live ones)."*

**Outcome: inventory produced, nothing pruned.** The reasoning is below, and the
short version is that zero frontend callers turned out to be necessary but
nowhere near sufficient evidence that a route is dead.

Measured 2026-09-09 against backend `crm/phase-2-3-consolidated` and frontend
`crm/phase-4-5-frontend`.

## Method

Every `@Get/@Post/@Patch/@Put/@Delete` under `src/modules/{leads,contacts,clients}`
was extracted with its `@Controller` prefix, giving **74 routes**. Each was
matched against every URL string literal in the frontend's `hooks/`, `features/`,
`app/`, `lib/` and `components/`, with `${…}` interpolations normalised to a
single wildcard segment and query strings stripped, comparing segment by segment
so a wildcard matches a `:param`.

The wildcard normalisation is deliberately generous in the direction that
*avoids* declaring a route dead. A URL assembled from a helper or a variable
matches more routes than it really calls, which risks calling a dead route live
— the safe error here.

## Result

**65 of 74 are called from the frontend. 9 are not:**

| Method | Route | Backend e2e | Permission gate |
|---|---|---|---|
| GET | `/clients/:clientId/activities` | yes | yes |
| POST | `/clients/:clientId/activities` | yes | yes |
| GET | `/clients/onboarding/templates` | yes | yes |
| POST | `/clients/onboarding/templates` | yes | yes |
| GET | `/contacts/:contactId/vcard` | yes | yes |
| PATCH | `/leads/:leadId/custom-data` | yes | `crm:leads:update` |
| POST | `/leads/:leadId/merge` | yes | yes |
| PATCH | `/leads/:leadId/reject` | yes | yes |
| PATCH | `/leads/:leadId/verify` | yes | `crm:leads:update` |

## Why none of these were pruned

**Every one of the nine is covered by a backend e2e spec** — the
`clients.controller.e2e-spec.ts`, `contacts.controller.e2e-spec.ts` and
`leads-extended.controller.e2e-spec.ts` auth-and-permission tables list them by
path and method — and **every one carries a `@RequirePermission` gate**. These
are maintained, guarded, tested HTTP surfaces. Not one is an orphan somebody
forgot.

That is a different thing from what the ticket set out to find. "No caller in
this frontend" is evidence that *this* client has not built a screen for it. It
is not evidence that nothing calls it, and three considerations make the gap
wide enough to stop at:

1. **The API is externally reachable.** This is a multi-tenant product; a
   tenant integration calling `PATCH /leads/:leadId/verify` is exactly the
   consumer this method cannot see. Deleting a route is an outward-facing,
   hard-to-reverse change, and nothing here establishes that no such caller
   exists.

2. **Several are lifecycle operations a frontend would plausibly grow into.**
   Verify, reject and merge on a lead are not vestigial verbs — they are the
   qualification workflow. Their absence from the UI reads as a screen not yet
   built rather than a feature retired.

3. **Pruning would delete passing tests.** Removing a route and its e2e
   coverage in the same change means the deletion is the only thing left
   asserting the deletion was right.

## What would make a prune decidable

Not more grepping. Any of:

- **Access logs** for these paths over a meaningful window, from an environment
  real clients talk to. Zero requests over a quarter is the evidence this
  exercise wanted and could not produce from source.
- **A deprecation cycle**: mark them deprecated in the OpenAPI document, return
  a `Deprecation` header, watch for callers, then remove.
- **A product statement** that lead verify/reject/merge and client onboarding
  templates are retired capabilities rather than unbuilt screens.

Until one of those exists, the inventory above is the useful artefact and the
routes stay mounted.

## Note on the other 65

They are called from the frontend and were not examined further. This exercise
was scoped to finding dead ones; it says nothing about whether the live ones are
well designed, correctly gated beyond having a gate, or duplicated by the Party
surface that now owns identity.
