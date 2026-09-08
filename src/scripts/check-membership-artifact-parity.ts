/**
 * check-membership-artifact-parity.ts — MEMBERSHIP_ARTIFACTS vs pg_catalog.
 *
 * WHAT THIS ANSWERS
 *   `MEMBERSHIP_ARTIFACTS` is the product's contract for what happens to every
 *   artifact hanging off an `organization_members` row when that membership is
 *   removed. It is prose plus a `RemovalAction`, and until now nothing executable
 *   compared it to the database it describes. A registry that says "the composite
 *   foreign key removes it with the membership" is a claim about pg_constraint;
 *   if the constraint says SET NULL instead, the registry is wrong and every
 *   reader of it is wrong with it.
 *
 * THE THIRD LEG
 *   Parity here has three sides, not two:
 *     registry  <-> catalog     this gate
 *     schema    <-> catalog     `pnpm check:referential-action-drift`
 *     registry  <-> schema      follows from the other two
 *   Run both. This gate deliberately does not re-parse the Drizzle source: that
 *   parser already exists next door and a second copy would drift from it.
 *
 * MECHANISM DECIDES WHAT IS EXPECTED — the registry says so itself
 *   database-cascade   the FOREIGN KEY does the work; its ON DELETE must equal
 *                      `onRemoval`. Absence of an FK is a finding: the registry
 *                      promises the database enforces something it does not.
 *   database-write     the APPLICATION does the work, so a missing FK is not a
 *                      finding — that is the design. What IS a finding is an FK
 *                      that DEFEATS the stated action, because the database acts
 *                      first and the hand-written cleanup never gets the chance:
 *                      blocks-removal under a CASCADE or SET NULL key does not
 *                      block, and set-null under a CASCADE key destroys the row
 *                      it was supposed to preserve.
 *                      A first cut of this gate demanded an FK here and reported
 *                      54 findings that were all the design working correctly.
 *   pending-migration  the entry documents a known gap. Reported, never failed —
 *                      but if the catalog has since caught up, it is announced as
 *                      RETIRABLE so the registry stops carrying a stale excuse.
 *   session-store · realtime · provider · cache
 *                      not a table relationship. Counted and skipped.
 *
 * TARGET SAFETY
 *   Reads only, but it still reads a database, and a number produced against a
 *   database nobody chose is not evidence. A non-loopback host is REFUSED (exit 2)
 *   unless MEMBERSHIP_PARITY_ALLOW_REMOTE=1. The resolved target is printed as
 *   host:port/database, never the URL.
 *
 *   MEMBERSHIP_PARITY_GATE_DATABASE_URL=postgres://... pnpm check:membership-parity
 *   pnpm check:membership-parity:self-test
 *
 * Exit codes
 *   0  every enforced expectation holds
 *   1  at least one expectation is violated
 *   2  refused target, or the scan resolved too little to mean anything
 */
import postgres from "postgres";

import { MEMBERSHIP_ARTIFACTS } from "../modules/organization/core/membership-artifacts";

const SELF_TEST = process.argv.includes("--self-test");
const LIST = process.argv.includes("--list");
const GATE_URL = process.env.MEMBERSHIP_PARITY_GATE_DATABASE_URL;
const ALLOW_REMOTE = process.env.MEMBERSHIP_PARITY_ALLOW_REMOTE === "1";

const MEMBERSHIP_TABLE = "organization_members";

/**
 * Floors, not targets. A registry rename or a barrel move would otherwise leave
 * this gate comparing an empty set and reporting clean.
 */
export const MIN_ARTIFACTS = 250;
export const MIN_ENFORCED = 150;
export const MIN_LIVE_MEMBERSHIP_FKS = 100;

export type Action = "cascade" | "restrict" | "no action" | "set null" | "set default";

export type LiveFk = {
  readonly table: string;
  readonly name: string;
  readonly columns: readonly string[];
  readonly onDelete: Action;
};

export type Expectation =
  | { readonly kind: "fk-action"; readonly action: Action }
  | { readonly kind: "fk-blocks" }
  | { readonly kind: "no-contradiction"; readonly onRemoval: string }
  | { readonly kind: "pending"; readonly intended: Action }
  | { readonly kind: "not-applicable"; readonly why: string };

export type Finding = {
  readonly id: string;
  readonly table: string;
  readonly column: string;
  readonly expected: string;
  readonly actual: string;
  readonly detail: string;
};

type Artifact = {
  readonly id: string;
  readonly mechanism: string;
  readonly table: string | null;
  readonly keyedBy: string;
  readonly onRemoval: string;
};

const CONFDELTYPE: Record<string, Action> = {
  a: "no action",
  r: "restrict",
  c: "cascade",
  n: "set null",
  d: "set default",
};

/**
 * `keyedBy` is prose as often as it is a column list: "membership_id",
 * "delegator_membership_id / delegatee_membership_id", "principal_type +
 * principal_id", "ably clientId = user_id". Take the identifier-shaped tokens and
 * let the caller drop the ones that are not columns of the table.
 */
export function parseKeyedBy(keyedBy: string): readonly string[] {
  return keyedBy
    .split(/[/+,]/)
    .map((part) => part.trim())
    .map((part) => {
      const match = /([a-z_][a-z0-9_]*)\s*$/.exec(part);
      return match?.[1] ?? "";
    })
    .filter((name) => name.length > 0 && name.includes("_"));
}

export function actionForRemoval(onRemoval: string): Action | null {
  if (onRemoval === "cascade") return "cascade";
  if (onRemoval === "set-null") return "set null";
  return null;
}

export function expectationFor(artifact: Artifact): Expectation {
  if (artifact.table === null)
    return { kind: "not-applicable", why: `${artifact.mechanism} has no table` };
  if (artifact.mechanism === "database-cascade") {
    if (artifact.onRemoval === "blocks-removal") return { kind: "fk-blocks" };
    const action = actionForRemoval(artifact.onRemoval);
    if (action === null)
      return { kind: "not-applicable", why: `database-cascade + ${artifact.onRemoval}` };
    return { kind: "fk-action", action };
  }
  if (artifact.mechanism === "database-write")
    return { kind: "no-contradiction", onRemoval: artifact.onRemoval };
  if (artifact.mechanism === "pending-migration") {
    const intended = actionForRemoval(artifact.onRemoval) ?? "set null";
    return { kind: "pending", intended };
  }
  return { kind: "not-applicable", why: artifact.mechanism };
}

export function blocks(action: Action): boolean {
  return action === "restrict" || action === "no action";
}

/** A finding is produced only where the registry made a checkable promise. */
export function evaluate(
  artifact: Artifact,
  columns: readonly string[],
  fksByColumn: ReadonlyMap<string, LiveFk>,
): { readonly findings: readonly Finding[]; readonly enforced: number; readonly retirable: readonly string[] } {
  const expectation = expectationFor(artifact);
  const findings: Finding[] = [];
  const retirable: string[] = [];
  let enforced = 0;
  if (expectation.kind === "not-applicable")
    return { findings, enforced, retirable };

  for (const column of columns) {
    const fk = fksByColumn.get(column);
    if (expectation.kind === "pending") {
      if (fk && fk.onDelete === expectation.intended)
        retirable.push(`${artifact.id} — ${artifact.table}.${column} is now ${fk.onDelete}`);
      continue;
    }
    enforced += 1;
    if (expectation.kind === "no-contradiction") {
      if (!fk) continue;
      const defeats =
        (expectation.onRemoval === "blocks-removal" && !blocks(fk.onDelete)) ||
        (expectation.onRemoval === "set-null" && fk.onDelete === "cascade") ||
        (expectation.onRemoval === "cascade" && fk.onDelete !== "cascade");
      if (defeats)
        findings.push({
          id: artifact.id,
          table: artifact.table ?? "",
          column,
          expected: `a foreign key that does not defeat onRemoval "${expectation.onRemoval}"`,
          actual: `${fk.name} ON DELETE ${fk.onDelete}`,
          detail:
            "the application performs this cleanup, but the database acts first and overrides it",
        });
      continue;
    }
    if (!fk) {
      findings.push({
        id: artifact.id,
        table: artifact.table ?? "",
        column,
        expected:
          expectation.kind === "fk-action"
            ? `ON DELETE ${expectation.action}`
            : "a foreign key that refuses the delete",
        actual: "no foreign key to organization_members",
        detail: "the registry promises the database enforces this; it does not",
      });
      continue;
    }
    if (expectation.kind === "fk-action" && fk.onDelete !== expectation.action)
      findings.push({
        id: artifact.id,
        table: artifact.table ?? "",
        column,
        expected: `ON DELETE ${expectation.action}`,
        actual: `${fk.name} ON DELETE ${fk.onDelete}`,
        detail: `onRemoval "${artifact.onRemoval}" and the catalog disagree`,
      });
    if (expectation.kind === "fk-blocks" && !blocks(fk.onDelete))
      findings.push({
        id: artifact.id,
        table: artifact.table ?? "",
        column,
        expected: "ON DELETE restrict or no action",
        actual: `${fk.name} ON DELETE ${fk.onDelete}`,
        detail: 'onRemoval "blocks-removal" but the delete is not blocked',
      });
  }
  return { findings, enforced, retirable };
}

function resolveTarget(): { url: string; label: string } | null {
  if (!GATE_URL) return null;
  const parsed = new URL(GATE_URL);
  const host = parsed.hostname;
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!loopback && !ALLOW_REMOTE) {
    console.error(
      `check-membership-artifact-parity: INCONCLUSIVE — the target resolved to "${host}:${parsed.port || "5432"}${parsed.pathname}", which is not a loopback host and was not chosen for this gate.`,
    );
    console.error("Set MEMBERSHIP_PARITY_ALLOW_REMOTE=1 to accept it. Nothing was measured.");
    process.exit(2);
  }
  return { url: GATE_URL, label: `${host}:${parsed.port || "5432"}${parsed.pathname}` };
}

async function readLiveFks(url: string): Promise<readonly LiveFk[]> {
  const sql = postgres(url, { ssl: url.includes("sslmode=disable") ? false : "require", max: 1, prepare: false });
  try {
    const rows = await sql<
      { table: string; name: string; columns: string[]; confdeltype: string }[]
    >`
      SELECT child.relname AS table, c.conname AS name, c.confdeltype,
             array_agg(att.attname ORDER BY att.attnum) AS columns
      FROM pg_constraint c
      JOIN pg_class child ON child.oid = c.conrelid
      JOIN pg_class parent ON parent.oid = c.confrelid
      JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND parent.relname = ${MEMBERSHIP_TABLE}
      GROUP BY child.relname, c.conname, c.confdeltype`;
    return rows.map((row) => ({
      table: row.table,
      name: row.name,
      columns: row.columns,
      onDelete: CONFDELTYPE[row.confdeltype] ?? "no action",
    }));
  } finally {
    await sql.end();
  }
}

function selfTest(): void {
  const checks: [string, unknown, unknown][] = [
    ["parses a slash pair", parseKeyedBy("a_membership_id / b_membership_id").length, 2],
    ["drops prose tokens", parseKeyedBy("ably clientId = user_id").join(","), "user_id"],
    ["drops bare words", parseKeyedBy("membership").length, 0],
    ["cascade maps", actionForRemoval("cascade"), "cascade"],
    ["set-null maps", actionForRemoval("set-null"), "set null"],
    ["blocks-removal does not map to an action", actionForRemoval("blocks-removal"), null],
    ["no action blocks", blocks("no action"), true],
    ["set null does not block", blocks("set null"), false],
  ];
  const art = (over: Partial<Artifact>): Artifact => ({
    id: "x", mechanism: "database-cascade", table: "t", keyedBy: "membership_id", onRemoval: "cascade", ...over,
  });
  const fk = (onDelete: Action): ReadonlyMap<string, LiveFk> =>
    new Map([["membership_id", { table: "t", name: "fk_x", columns: ["membership_id"], onDelete }]]);

  checks.push([
    "a matching cascade produces no finding",
    evaluate(art({}), ["membership_id"], fk("cascade")).findings.length, 0,
  ]);
  checks.push([
    "a set-null catalog under a cascade registry IS a finding",
    evaluate(art({}), ["membership_id"], fk("set null")).findings.length, 1,
  ]);
  checks.push([
    "a missing FK under database-cascade IS a finding",
    evaluate(art({}), ["membership_id"], new Map()).findings.length, 1,
  ]);
  checks.push([
    "database-cascade blocks-removal accepts restrict",
    evaluate(art({ onRemoval: "blocks-removal" }), ["membership_id"], fk("restrict")).findings.length, 0,
  ]);
  checks.push([
    "database-cascade blocks-removal rejects cascade",
    evaluate(art({ onRemoval: "blocks-removal" }), ["membership_id"], fk("cascade")).findings.length, 1,
  ]);
  checks.push([
    "database-write needs no FK — the application enforces it",
    evaluate(art({ mechanism: "database-write", onRemoval: "blocks-removal" }), ["membership_id"], new Map()).findings.length, 0,
  ]);
  checks.push([
    "database-write tolerates an FK that agrees",
    evaluate(art({ mechanism: "database-write", onRemoval: "set-null" }), ["membership_id"], fk("set null")).findings.length, 0,
  ]);
  checks.push([
    "database-write set-null rejects an FK that CASCADES the row away",
    evaluate(art({ mechanism: "database-write", onRemoval: "set-null" }), ["membership_id"], fk("cascade")).findings.length, 1,
  ]);
  checks.push([
    "database-write blocks-removal rejects an FK that does not block",
    evaluate(art({ mechanism: "database-write", onRemoval: "blocks-removal" }), ["membership_id"], fk("set null")).findings.length, 1,
  ]);
  checks.push([
    "pending-migration never fails",
    evaluate(art({ mechanism: "pending-migration", onRemoval: "set-null" }), ["membership_id"], fk("restrict")).findings.length, 0,
  ]);
  checks.push([
    "pending-migration announces a caught-up catalog",
    evaluate(art({ mechanism: "pending-migration", onRemoval: "set-null" }), ["membership_id"], fk("set null")).retirable.length, 1,
  ]);
  checks.push([
    "a cache artifact is not applicable",
    evaluate(art({ mechanism: "cache", table: null }), ["membership_id"], fk("cascade")).enforced, 0,
  ]);

  let failed = 0;
  for (const [name, actual, expected] of checks) {
    const ok = actual === expected;
    if (!ok) failed += 1;
    console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : ` — got ${String(actual)}, want ${String(expected)}`}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} self-tests passed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function main(): Promise<void> {
  if (SELF_TEST) return selfTest();

  const artifacts: readonly Artifact[] = MEMBERSHIP_ARTIFACTS;
  if (artifacts.length < MIN_ARTIFACTS) {
    console.error(
      `check-membership-artifact-parity: INCONCLUSIVE — resolved ${String(artifacts.length)} artifacts, floor is ${String(MIN_ARTIFACTS)}. The registry import is broken, not the database.`,
    );
    process.exit(2);
  }

  const target = resolveTarget();
  if (!target) {
    console.error(
      "check-membership-artifact-parity: INCONCLUSIVE — no target. Whether a foreign key exists and what it does on delete lives only in pg_constraint; nothing static can see it.",
    );
    console.error("  Set MEMBERSHIP_PARITY_GATE_DATABASE_URL to a database bootstrapped to journal head.");
    process.exit(2);
  }

  const live = await readLiveFks(target.url);
  if (live.length < MIN_LIVE_MEMBERSHIP_FKS) {
    console.error(
      `check-membership-artifact-parity: INCONCLUSIVE — only ${String(live.length)} foreign keys reference ${MEMBERSHIP_TABLE}, floor is ${String(MIN_LIVE_MEMBERSHIP_FKS)}. An unbootstrapped database has nothing to contradict.`,
    );
    process.exit(2);
  }

  const byTableColumn = new Map<string, LiveFk>();
  for (const fk of live)
    for (const column of fk.columns)
      if (column !== "org_id" && column !== "organization_id")
        byTableColumn.set(`${fk.table}.${column}`, fk);

  const findings: Finding[] = [];
  const retirable: string[] = [];
  const byMechanism = new Map<string, number>();
  let enforced = 0;
  let applicable = 0;

  for (const artifact of artifacts) {
    byMechanism.set(artifact.mechanism, (byMechanism.get(artifact.mechanism) ?? 0) + 1);
    if (artifact.table === null) continue;
    const columns = parseKeyedBy(artifact.keyedBy);
    const scoped = new Map<string, LiveFk>();
    for (const column of columns) {
      const fk = byTableColumn.get(`${artifact.table}.${column}`);
      if (fk) scoped.set(column, fk);
    }
    const result = evaluate(artifact, columns, scoped);
    if (expectationFor(artifact).kind !== "not-applicable") applicable += 1;
    enforced += result.enforced;
    findings.push(...result.findings);
    retirable.push(...result.retirable);
  }

  console.log(`Target                 ${target.label}  (from MEMBERSHIP_PARITY_GATE_DATABASE_URL)`);
  console.log(`Registry artifacts     ${String(artifacts.length)}`);
  for (const [mechanism, count] of [...byMechanism].sort())
    console.log(`  ${mechanism.padEnd(20)} ${String(count)}`);
  console.log(`Live FKs -> ${MEMBERSHIP_TABLE}  ${String(live.length)}`);
  console.log(`Artifacts with a checkable promise  ${String(applicable)}`);
  console.log(`Column-level expectations enforced  ${String(enforced)}`);

  if (enforced < MIN_ENFORCED) {
    console.error(
      `\ncheck-membership-artifact-parity: INCONCLUSIVE — only ${String(enforced)} expectations were enforced, floor is ${String(MIN_ENFORCED)}. A keyedBy format change would land here rather than reporting clean.`,
    );
    process.exit(2);
  }

  if (retirable.length > 0) {
    console.log(`\nPending-migration entries the catalog has caught up with (${String(retirable.length)}):`);
    for (const line of retirable) console.log(`  RETIRABLE  ${line}`);
  }

  if (findings.length === 0) {
    console.log(
      `\nOK — every checkable MEMBERSHIP_ARTIFACTS promise matches the catalog at this target.`,
    );
    return;
  }

  console.error(`\nFAIL — ${String(findings.length)} registry promise(s) the database does not keep:`);
  for (const finding of LIST ? findings : findings.slice(0, 40))
    console.error(
      `  ${finding.table}.${finding.column}  [${finding.id}]\n      expected ${finding.expected}\n      actual   ${finding.actual}\n      ${finding.detail}`,
    );
  if (!LIST && findings.length > 40)
    console.error(`  … and ${String(findings.length - 40)} more (--list for all)`);
  console.error(
    "\nFix: change one side deliberately. If the catalog is right, correct the MEMBERSHIP_ARTIFACTS entry and its reason. If the registry is right, write a migration and register it in migrations/meta/_journal.json.",
  );
  process.exit(1);
}

void main();
