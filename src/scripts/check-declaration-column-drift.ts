#!/usr/bin/env node
/**
 * Gate: no live column that an INSERT must supply may be missing from the Drizzle
 * declaration, and no declared column may be missing from the live table.
 *
 * The defect class this exists for is `support_ticket_watchers.user_id` (migration
 * 1046). `0865` expanded the table onto `user_membership_id`, `0866` validated the
 * new foreign key, and no migration ever contracted the pair — while the Drizzle
 * declaration stopped declaring `user_id`. The column stayed `NOT NULL` with no
 * default, so every insert Drizzle built omitted a column Postgres required and
 * `POST /support/:supportTicketId/follow` answered 500 to every caller in every
 * tenant. 73 tables sit in the same expanded state; that one is the only one whose
 * declaration dropped the legacy column, which is why it is the only one failing.
 *
 * Report 07b (`reports/07b-declaration-drift.md`) scanned two populations and this
 * fell between them:
 *
 *   Population A — live TABLES with no declaration. Table granularity.
 *                  `support_ticket_watchers` IS declared, so it was never a row.
 *   Population B — DECLARED `.references()` with no constraint in the catalog.
 *                  Declaration -> live, and foreign keys only. `user_id` was not
 *                  declared at all, so it could not be one of the 1,385 parsed.
 *
 * Neither population is live -> declaration at COLUMN granularity. That is this
 * gate's population, and it is the one that breaks writes.
 *
 * `check:drop-column-safety` is the static sibling and covers a different case: a
 * column dropped by an UNAPPLIED migration that the schema still declares. It reads
 * `migrations/`, so drift that never came through a `DROP COLUMN` statement — which
 * is exactly this one, since no migration ever dropped anything — is invisible to it.
 *
 * Two verdict classes, because they fail differently:
 *
 *   WRITE-BLOCKING  a live column that is NOT NULL, has no default, and is neither
 *                   generated nor an identity column, absent from the declaration.
 *                   Drizzle omits it from every INSERT and Postgres raises 23502.
 *   READ-BLOCKING   a declared column with no live counterpart. Drizzle emits it in
 *                   every `findFirst`/`findMany` without an explicit projection and
 *                   Postgres raises 42703.
 *
 * A live column that is nullable or defaulted and undeclared is REPORTED, never
 * failed: writes still succeed, the column is merely invisible to the runtime. That
 * bucket is where the other 72 expanded tables would sit if their declarations were
 * ever trimmed, so its size is the leading indicator and it is printed every run.
 *
 * The discriminator that makes the write-blocking class usable — and the reason a
 * naive NOT NULL scan is a broken scan. The first run of this gate reported 23
 * write-blocking columns. Twenty-two were `org_id` on a child table
 * (`invoice_items`, `quote_line_items`, every `inv_*_lines`, …) and every one of
 * them is a FALSE POSITIVE: the table carries a `BEFORE INSERT … FOR EACH ROW`
 * trigger `trg_set_org_id` running `set_org_id_from_parent(parent, 'id', 'org_id',
 * fk)`, so the tenant column is derived from the parent and is deliberately NOT
 * declared, precisely so the ORM cannot write it. Postgres never demands a value
 * for it. `support_ticket_watchers` carries no trigger at all, which is why it was
 * the one that actually 500'd. So a NOT NULL, no-default, undeclared column is
 * write-blocking only when no BEFORE INSERT row trigger on that table names it;
 * otherwise it is reported as trigger-supplied. Validated in both directions: the
 * 22 downgrade and the 1 still fails.
 *
 * The mechanism sits in `declaration-column-drift/` under CLAUDE.md §7 — the live
 * catalog reads and their two predicates in `catalog.ts`, the Drizzle barrel walker
 * in `declared.ts`, the four-bucket verdict in `compare.ts`, and the bite proof in
 * `self-test.ts`. This file owns the narrative, the floors, and the run.
 *
 * Usage:
 *   node -r ts-node/register/transpile-only src/scripts/check-declaration-column-drift.ts
 *   node -r ts-node/register/transpile-only src/scripts/check-declaration-column-drift.ts --self-test
 *   COLUMN_DRIFT_GATE_DATABASE_URL=postgresql://… node -r ts-node/register/transpile-only \
 *     src/scripts/check-declaration-column-drift.ts
 *
 * The URL is a dedicated variable rather than DATABASE_URL so a local run cannot
 * reach the shared instance by inheriting it. The gate only ever SELECTs from
 * pg_catalog.
 *
 * Exit codes:
 *   0  clean, or accepted as PARTIAL via STREAMLINE_ALLOW_PARTIAL_GATES=1
 *   1  a write-blocking or read-blocking drift (or a self-test failure)
 *   2  INCONCLUSIVE — no database, or the scan is vacuous
 */

import postgres from "postgres";

import * as schema from "../db/schema";
import type { LiveColumn, LiveTrigger } from "./declaration-column-drift/catalog";
import { INSERT_TRIGGERS_QUERY, LIVE_COLUMNS_QUERY } from "./declaration-column-drift/catalog";
import { compare } from "./declaration-column-drift/compare";
import { countDeclaredColumns, declaredTablesOf } from "./declaration-column-drift/declared";
import { runSelfTest } from "./declaration-column-drift/self-test";

const SELF_TEST = process.argv.includes("--self-test");
const GATE_URL = process.env.COLUMN_DRIFT_GATE_DATABASE_URL;
const ALLOW_PARTIAL = process.env.STREAMLINE_ALLOW_PARTIAL_GATES === "1";

/**
 * Floors, not targets. A barrel rename or a `getTableConfig` API change would
 * otherwise leave this gate comparing nothing against nothing and reporting clean.
 * They are declared here because `baselines/ratchets.json` registers them against
 * this file; `check:baseline-integrity` reads them from top-level `check-*` scripts
 * only, so moving them into the split modules would strand three registry entries.
 */
const MIN_DECLARED_TABLES = 700;
const MIN_DECLARED_COLUMNS = 5000;
const MIN_LIVE_COLUMNS = 5000;

async function main(): Promise<void> {
  if (SELF_TEST)
    runSelfTest(schema as unknown as Record<string, unknown>, {
      declaredTables: MIN_DECLARED_TABLES,
      declaredColumns: MIN_DECLARED_COLUMNS,
    });

  const declared = declaredTablesOf(schema as unknown as Record<string, unknown>);
  const declaredColumns = countDeclaredColumns(declared);
  console.log(`Declared tables ${String(declared.length)}  ·  declared columns ${String(declaredColumns)}`);

  if (declared.length < MIN_DECLARED_TABLES || declaredColumns < MIN_DECLARED_COLUMNS) {
    console.error(
      `INCONCLUSIVE — the declaration scan found ${String(declared.length)} tables (floor ${String(MIN_DECLARED_TABLES)}) and ${String(declaredColumns)} columns (floor ${String(MIN_DECLARED_COLUMNS)}). A clean result over an empty scan proves nothing.`,
    );
    process.exit(2);
  }

  if (GATE_URL === undefined || GATE_URL === "") {
    const stream = ALLOW_PARTIAL ? console.warn : console.error;
    stream(
      `${ALLOW_PARTIAL ? "PARTIAL" : "INCONCLUSIVE"} — the catalog half did not run. Whether a live column is missing from a declaration is only in pg_attribute; nothing static can see it, so all ${String(declared.length)} declared tables are UNVERIFIED.`,
    );
    stream("  Set COLUMN_DRIFT_GATE_DATABASE_URL to a database bootstrapped to head to run it.");
    if (!ALLOW_PARTIAL) {
      console.error("  Or set STREAMLINE_ALLOW_PARTIAL_GATES=1 to accept a declaration-only run.");
      process.exit(2);
    }
    console.warn("  STREAMLINE_ALLOW_PARTIAL_GATES=1 — this run proves nothing about the catalog.");
    return;
  }

  const sql = postgres(GATE_URL, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const live = (await sql.unsafe(LIVE_COLUMNS_QUERY)) as unknown as LiveColumn[];
    if (live.length < MIN_LIVE_COLUMNS) {
      console.error(
        `INCONCLUSIVE — the catalog reports ${String(live.length)} columns (floor ${String(MIN_LIVE_COLUMNS)}). This database is not bootstrapped to head; the catalog half proves nothing.`,
      );
      process.exit(2);
    }

    const triggers = (await sql.unsafe(INSERT_TRIGGERS_QUERY)) as unknown as LiveTrigger[];
    const report = compare(declared, live, triggers);
    console.log(
      `Live columns ${String(live.length)}  ·  tables compared ${String(report.comparedTables)}  ·  declared-but-absent tables ${String(report.missingTables.length)}  ·  live-but-undeclared tables ${String(report.undeclaredTables.length)}`,
    );
    console.log(
      `Undeclared-but-harmless live columns (nullable or defaulted) ${String(report.invisible.length)} — reported, not failed.`,
    );
    console.log(
      `Undeclared live columns supplied by a BEFORE INSERT trigger ${String(report.triggerSupplied.length)} (of ${String(triggers.length)} such triggers) — reported, not failed.`,
    );
    for (const f of report.triggerSupplied) console.log(`  ${f.key}.${f.column}  — ${f.detail}`);

    let failed = false;
    if (report.writeBlocking.length > 0) {
      failed = true;
      console.error(
        `FAIL — ${String(report.writeBlocking.length)} live column(s) are NOT NULL with no default and missing from the declaration. Every Drizzle INSERT on these tables raises 23502:`,
      );
      for (const f of report.writeBlocking) console.error(`  ${f.key}.${f.column}  — ${f.detail}`);
    }
    if (report.readBlocking.length > 0) {
      failed = true;
      console.error(
        `FAIL — ${String(report.readBlocking.length)} declared column(s) have no live counterpart. Every unprojected read raises 42703:`,
      );
      for (const f of report.readBlocking) console.error(`  ${f.key}.${f.column}  — ${f.detail}`);
    }
    if (failed) {
      console.error(
        "\nFix: contract the pair with a migration (drop the legacy column) or restore the column to the declaration. Never one without measuring the other.",
      );
      process.exit(1);
    }

    console.log("Catalog half OK — no write-blocking or read-blocking column drift.");
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(`check-declaration-column-drift: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
