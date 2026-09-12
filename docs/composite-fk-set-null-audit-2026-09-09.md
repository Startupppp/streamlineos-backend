# `ON DELETE SET NULL` over a NOT NULL column — audit and handoff

**Date:** 2026-09-09 · **Branch:** `crm/phase-2-3-consolidated` · **Fixed in:** migration `0662`
**Gate:** `pnpm check:composite-fk-set-null` (self-test: `pnpm check:composite-fk-set-null:self-test`)

## The defect

Postgres's bare `ON DELETE SET NULL` nulls **every** column of the key. On a
tenant-composite key `(org_id, <x>_id)` it emits:

```
UPDATE ONLY <child> SET "org_id" = NULL, "<x>_id" = NULL WHERE ...
```

`org_id` is NOT NULL, so the parent `DELETE` aborts with a not-null violation
**on the child table**. The constraint can never perform the action it declares.

Measured on `streamline_crm_merge`, deleting a `business_parties` row that has a
consent row:

```
ERROR:  null value in column "org_id" of relation "crm_contact_channel_consent"
        violates not-null constraint
CONTEXT: SQL statement "UPDATE ONLY "public"."crm_contact_channel_consent"
         SET "org_id" = NULL, "contact_party_id" = NULL WHERE ..."
```

Nothing catches this at write time: the DDL is accepted, the constraint
validates, and every read behaves normally. Parties are normally **soft**-deleted
(`business_parties.deleted_at`), so the only path that reaches it is DPDP/GDPR
erasure — the one place a hard delete is legally required.

## Census

The reported census used `array_length(c.conkey,1) > 1` and no `confdelsetcols`
check. Correcting both changes the numbers:

| | count | note |
|---|---|---|
| Reported composite | 46 | |
| — already correct | 3 | use PG15's column-list form; **not** defects |
| — genuinely broken (composite) | 43 | |
| Broken at arity 1 (missed by the census) | 7 | single-column keys to `users` |
| **Total genuinely broken** | **50** | |

The 3 false positives — `fk_role_assignments_assigner_membership`,
`fk_user_permission_grants_granter_membership`,
`fk_vault_access_logs_vault_document_id_org` — declare
`ON DELETE SET NULL (<column>)`, which nulls only the named column. Any census
or gate must read `pg_constraint.confdelsetcols`, or it reports correct
constraints as broken. After `0662` the original query returns 18, of which only
6 are real.

## Origin

Not deliberate design. The bulk comes from `0272`/`0275` (Phase 2 ticket 08),
which ported the legacy single-column `client_id`/`lead_id` keys to the composite
tenant form. Their stated purpose was cross-tenant safety — *"a bare `REFERENCES`
… would permit exactly the cross-tenant reference the whole identity model exists
to prevent"* — and the `ON DELETE` clause was carried across unchanged. Nothing
intended to change delete semantics, and nobody can have intended to null
`org_id`: that orphans the row from its tenant even if `org_id` were nullable.

`0619` then transcribed the broken shape back out of `pg_catalog`
(63 bare `SET NULL`s, **zero** column-list forms), which is why it reads as
authored. `0619` is a symptom, not the origin.

## The two repairs, and why each

**`NO ACTION` — 28 keys.** Everything keyed to `business_parties`, plus
`deals→subjects` and `crm_nurture_enrollments→deals`. These are the erasure path.
`subject-request-plan.ts` is explicit that a disposition is declared per table
and executed explicitly: a table with no declared disposition *"is neither erased
… nor skipped in silence"*. A database-level `SET NULL` would silently perform an
undeclared disposition on 26 tables the compliance design deliberately refuses to
decide about, and would leave rows that still hold personal data — an orphaned
consent row keeps `contact_id`; an orphaned invoice keeps a client that no longer
resolves. `NO ACTION` preserves the behaviour these already have (the delete is
refused) and replaces an incoherent not-null error with one that names the
blocking table.

**`SET NULL (<column>)` — 9 keys.** The `kb_*` structural set. `0635` authored
`SET NULL` deliberately and it is right: an article whose category is deleted
becomes uncategorised, a page whose space or parent is deleted becomes unfiled or
top-level. No parent in this group is personal data and no erasure path runs
through it. Precedent for the syntax is `0607` and `0634`.

Verified after `0662`, in a rolled-back transaction:

- deleting a party with a consent row → clean FK error naming
  `crm_contact_channel_consent`;
- clearing consent + events, then deleting the party → succeeds;
- deleting a `kb_categories` row → the article survives, `org_id` kept,
  `category_id` nulled.

---

## Handoff 1 — build module (6 keys)

`src/modules/build/**` was out of scope. These carry the identical defect and
each aborts a `business_parties` hard delete:

| Table | Constraint |
|---|---|
| `build.tickets` | `fk_tickets_customer_party_id` |
| `build.tickets` | `fk_tickets_customer_org_party_id` |
| `build.feedback_posts` | `fk_feedback_posts_crm_contact_party_id` |
| `build.feedback_posts` | `fk_feedback_posts_crm_organization_party_id` |
| `build.feedbucket_submissions` | `fk_feedbucket_submissions_crm_contact_party_id` |
| `build.feedbucket_submissions` | `fk_feedbucket_submissions_crm_organization_party_id` |

All six are `(org_id, <x>_party_id) → business_parties(organization_id, party_id)`
with a nullable pointer and a NOT NULL `org_id`. The decision is the same one
`0662` made: these reference a party, so `NO ACTION` matches the erasure design —
unless build wants a ticket to outlive its customer with a nulled pointer, in
which case `ON DELETE SET NULL ("customer_party_id")`.

## Handoff 2 — hr and sign (7 keys, arity 1)

Missed by the reported census because it filtered `array_length > 1`. All are
`→ users(id) ON DELETE SET NULL` on a **NOT NULL** column, so purging a user
aborts — `scripts/purge-user.mjs` is the path that hits this.

| Owner | Table.column |
|---|---|
| hr | `hr_disciplinary_actions.issued_by` |
| hr | `hr_effective_dated_changes.created_by` |
| hr | `hr_emergency_events.created_by` |
| hr | `hr_safety_incidents.reported_by` |
| hr | `hr_simulations.created_by` |
| sign | `sign_bulk_send_jobs.sender_user_id` |
| sign | `sign_envelopes.sender_user_id` |

Here the fix is a genuine choice, because the column is NOT NULL: either drop the
`NOT NULL` (an author who no longer exists becomes null) or change the action to
`NO ACTION` (a user cannot be purged until these rows are handled). For `sign_*`,
a sent envelope arguably must keep its sender, which points at `NO ACTION`.

All 13 are listed in `KNOWN_UNFIXED` in
`src/scripts/check-composite-fk-set-null.mjs`, so the gate is green today and
fails on anything new. **Removing an entry from that map is part of fixing it** —
a stale entry fails the gate too, so the map cannot rot.

## Reintroduction risk

drizzle-orm 0.45's `UpdateDeleteAction` is a plain string union and **cannot**
express the column-list form; `.onDelete("set null")` always emits the bare
keyword. Four composite FKs in `src/db/schema/kb/` declare it, so regenerating
them from Drizzle would reinstall the defect. Those sites are annotated, and the
gate is the backstop.
