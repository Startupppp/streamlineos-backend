# CRM golden path — recorded run

**Date:** 2026-09-10
**Branch:** `crm/phase-2-3-consolidated`
**Ticket:** CRM-P0-06 — "Golden-path regression gate docs + confirm 6/6 under `APP_DATABASE_URL`"

`docs/crm-final-handoff.md` asserted the golden path was green, but no artifact
in this repository recorded the command line, the output or the exit code, so
the claim could only be taken on trust. This file is that artifact. It is a
transcript, not a summary — if it disagrees with prose elsewhere, believe this
file and fix the prose.

**Result: green, exit code 0 — but 7 tests, not the 6 the handoff claimed.** The
suite grew a seventh case (`refuses to enable the cold track until a domain is
proved`) after the 2026-09-08 handoff was written. Nothing regressed; the number
in the doc went stale. It has been corrected rather than restated.

---

## Database, built cold to this branch's head

The run is only meaningful on a database built from the journal, as the
non-owner app role. `crm_cold_0908` is the cold-built database from the
2026-09-08 verification; this branch's journal has since grown from 417 entries
to 433, so it was brought forward with the same idempotent bootstrap (which
skips by migration hash — it does not rebuild).

```bash
DATABASE_URL="postgres://$(whoami)@127.0.0.1:5432/crm_cold_0908" PGSSLMODE=disable \
  node src/scripts/db-bootstrap.mjs
```

```
OK    [0657a_crm_whatsapp_channels]
OK    [0658a_crm_whatsapp_channels_fail_closed]
OK    [0659a_sign_sweep_runs]
OK    [0660a_sign_bulk_row_attempts]
OK    [0661a_business_parties_timezone]
OK    [0662a_composite_fk_set_null_nulls_tenant]
OK    [0663a_audit_logs_unattributed_actor]
OK    [0664a_crm_report_schedules]
OK    [0665a_crm_mcp_off_by_default]
OK    [0666a_lifecycle_expansion_trigger]
OK    [0667a_crm_segments]
OK    [0668a_crm_call_analyses_window]
OK    [0669a_crm_deal_competitor_suggestions]
OK    [0670a_crm_contacts_view_not_scopable]
OK    [0671a_accounting_reads_not_scopable]
OK    [0672a_gl_system_tag_inventory_roles]

RESULT: REACHED_HEAD 433/433
```

> The run printed the unsuffixed tags. They are shown here under the names they
> carry since 2026-09-11, when the crm lane's 0656-0674 took a letter suffix to
> stop colliding with origin/main's numbers. Content and hashes are unchanged.

`migrations/meta/_journal.json` carries 433 entries, last tag
`0672a_gl_system_tag_inventory_roles`, so 433/433 is head and not a partial run.

Grants re-applied for the 16 new migrations' tables:

```bash
DATABASE_URL="postgres://$(whoami)@127.0.0.1:5432/crm_cold_0908" PGSSLMODE=disable \
  node src/scripts/db-bootstrap-app-role.mjs
```

```
--- verification ---
superuser=false createdb=false createrole=false bypassrls=false login=true
tables granted: 946/946
can create objects in: (none) (must be none)

RESULT: READY — point APP_DATABASE_URL at streamline_app to run the app under RLS.
```

`bypassrls=false` is the load-bearing line. Run as the owner instead, the
harness self-tests pass vacuously and the golden path's hold assertion changes
answer — a green run without `APP_DATABASE_URL` has measured nothing about RLS.

---

## The run

```bash
DATABASE_URL="postgres://$(whoami)@127.0.0.1:5432/crm_cold_0908" \
APP_DATABASE_URL="postgres://streamline_app@127.0.0.1:5432/crm_cold_0908" \
PGSSLMODE=disable \
  node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
  --config ./jest-e2e-seeded.json --forceExit --runInBand --verbose \
  test/crm/crm-golden-path.seeded-e2e-spec.ts
```

Output, verbatim:

```
{"timestamp":"2026-09-10T07:59:13.500Z","level":"info","message":"Email sent (resend)","meta":{"to":["ops@acme.example"],"subject":"Just Checking In","id":"7b71fd85-2867-472f-801b-69ab69931b26"}}
PASS test/crm/crm-golden-path.seeded-e2e-spec.ts (78.427 s)
  [seeded-e2e] CRM golden path — stranger to held send
    ✓ turns a stranger's message into a party, a filed activity and an extracted next step (7346 ms)
    ✓ stops a held send inside the window, and nothing leaves (17142 ms)
    ✓ lets the next one go when its window runs out, and records the send (18694 ms)
    ✓ still resolves a legacy contact id to a party, with the table long gone (101 ms)
    ✓ reverses a duplicate merge, putting the loser back (2675 ms)
    ✓ refuses a denied reader rather than handing back an empty list (2933 ms)
    ✓ refuses to enable the cold track until a domain is proved (4248 ms)

Test Suites: 1 passed, 1 total
Tests:       7 passed, 7 total
Snapshots:   0 total
Time:        78.979 s, estimated 101 s
Ran all test suites matching /test\/crm\/crm-golden-path.seeded-e2e-spec.ts/i.
Force exiting Jest: Have you considered using `--detectOpenHandles` to detect async operations that kept running after all tests finished?
```

```
EXIT=0
```

The exit code was read from `$?` on the jest process itself, not inferred from
the text. Reading it matters here: a suite that dies in `beforeAll` still prints
lines that grep as green.

---

## Two things this run surfaced

**1. The "6/6" was a stale count, not a false claim.** The spec now has seven
`it` blocks. `docs/crm-final-handoff.md` has been corrected to 7/7 with this
file cited. The correction is upward — nothing was removed or skipped to reach
it.

**2. The seeded harness sends a real email.** The first log line above is not a
fixture. `jest-e2e-seeded.json` loads `.env` through `dotenv/config`, `.env`
sets `EMAIL_PROVIDER=resend` with a live `RESEND_API_KEY`, and
`test/helpers/seeded-e2e-app.ts` stubs no mail transport — so the "records the
send" case performs a genuine Resend API call and gets back a message id. The
recipient is `ops@acme.example`, and `.example` is a reserved non-deliverable
TLD, so nothing reaches a human — but the call, the credential use and the
provider quota are real, and they would be real for any address a future fixture
happens to use. Worth closing separately; it is not a golden-path defect and was
not changed here.

---

## Scope of this artifact

This records **the golden path**, which is what CRM-P0-06 names
(`Test: crm-golden-path seeded e2e`). It deliberately does **not** re-measure
the whole seeded suite. That suite is now 42 spec files, against the 6 the
handoff's whole-suite number was taken from, and another agent held the 12 GB
seeded harness on this machine while this ran — two concurrent runs of it is a
documented way to produce fake failures. The handoff's whole-suite figure has
been marked as the historical measurement it is rather than silently carried
forward.
