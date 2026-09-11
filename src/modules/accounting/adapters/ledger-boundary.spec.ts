import { execSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * PRD 07 acceptance 1 — nothing outside accounting writes the ledger.
 *
 * This is a structural test rather than a runtime one on purpose. A runtime
 * check can only catch the paths a test happens to exercise; grepping the tree
 * catches the one a well-meaning engineer adds to Billing next quarter, which is
 * exactly the failure mode the anti-corruption layer exists to prevent.
 */

const SRC = resolve(__dirname, "../../..");

/** Files allowed to name the ledger tables in a write position. */
const KERNEL_WRITERS = [
  "modules/accounting/kernel/ledger.service.ts",
  "db/schema/accounting/gl-kernel.ts",
];

/**
 * Files outside accounting allowed to *name* a ledger table, read-only.
 *
 * The invariant this whole file defends is that nothing outside accounting
 * **writes** the ledger, and the first three tests prove that independently by
 * grepping the entire tree for inserts and updates — an entry here can never
 * buy a write. What it buys is the right to ask a counting question.
 *
 * The single entry earns it: deleting an org unit must refuse while anything
 * has been posted against it as a branch dimension, and that FK is
 * ON DELETE SET NULL, so without the check a hard delete silently strips the
 * dimension off posted history rather than refusing. Routing a COUNT through
 * an accounting service would make Organization depend on Accounting for a
 * referential-integrity guard that is Organization's own business.
 *
 * Adding a second entry should feel harder than this one did.
 */
const READ_ONLY_REFERENCES = [
  // The count moved here when org-hierarchy-dependencies.service.ts was split;
  // the service itself no longer names the table.
  "modules/organization/hierarchy/lib/org-unit-kind-dependencies.ts",
];

function grep(pattern: string): string[] {
  try {
    const out = execSync(
      `grep -rlE ${JSON.stringify(pattern)} ${JSON.stringify(SRC)} --include=*.ts || true`,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((abs) => abs.slice(SRC.length + 1));
  } catch {
    return [];
  }
}

describe("ledger boundary", () => {
  it("has exactly one service that inserts into gl_journals or gl_journal_lines", () => {
    const writers = grep("\\.insert\\(\\s*(glJournals|glJournalLines)\\s*\\)").filter(
      (f) => !f.endsWith(".spec.ts") && !f.endsWith(".e2e-spec.ts"),
    );

    expect(writers.sort()).toEqual(["modules/accounting/kernel/ledger.service.ts"]);
  });

  it("has no UPDATE or DELETE against journal lines anywhere in production code", () => {
    const mutators = grep("\\.(update|delete)\\(\\s*glJournalLines\\s*\\)").filter(
      (f) => !f.endsWith(".spec.ts") && !f.endsWith(".e2e-spec.ts"),
    );
    expect(mutators).toEqual([]);
  });

  it("only lets the kernel update a journal header, and only to link a reversal", () => {
    const mutators = grep("\\.update\\(\\s*glJournals\\s*\\)").filter(
      (f) => !f.endsWith(".spec.ts") && !f.endsWith(".e2e-spec.ts"),
    );
    expect(mutators.sort()).toEqual(["modules/accounting/kernel/ledger.service.ts"]);
  });

  it("keeps the ledger tables out of every non-accounting module", () => {
    const referencing = grep("\\b(glJournals|glJournalLines)\\b").filter(
      (f) =>
        f.startsWith("modules/") &&
        !f.startsWith("modules/accounting/") &&
        !READ_ONLY_REFERENCES.includes(f),
    );
    expect(referencing).toEqual([]);
  });

  it("confines the kernel schema import to accounting and the schema barrel", () => {
    const referencing = grep("\\bglJournalLines\\b").filter(
      (f) =>
        !f.startsWith("modules/accounting/") &&
        !f.startsWith("db/schema/") &&
        !READ_ONLY_REFERENCES.includes(f),
    );
    expect(referencing).toEqual([]);
  });

  it("holds every read-only exception to reading — no inserts, updates or deletes", () => {
    // The allowlist above is deliberately narrow, so prove each entry stays
    // within what it was granted rather than trusting the comment.
    const writers = grep(
      "\\.(insert|update|delete)\\(\\s*(glJournals|glJournalLines)\\s*\\)",
    );
    for (const allowed of READ_ONLY_REFERENCES) {
      expect(writers).not.toContain(allowed);
    }
  });

  it("names the files that are permitted to be ledger writers, so a change is deliberate", () => {
    // A guard on the guard: if someone renames the kernel, this fails and makes
    // them update the allowlist consciously rather than by accident.
    for (const file of KERNEL_WRITERS) {
      expect(grep("\\bglJournals\\b")).toContain(file);
    }
  });

  it("does not let another module import the accounting posting services", () => {
    const importers = grep('from "[^"]*accounting/kernel/ledger\\.service"').filter(
      (f) => f.startsWith("modules/") && !f.startsWith("modules/accounting/"),
    );
    expect(importers).toEqual([]);
  });

  /*
    ACC-07/ACC-19. Every assertion above matches the Drizzle *identifier* —
    `.insert(glJournals)`, `\bglJournalLines\b`. Raw SQL names the table, not
    the symbol, so `tx.execute(sql`INSERT INTO gl_journals ...`)` in any module
    would have passed all seven of them.

    Nothing exploits that today: measured across `src`, the only raw mentions of
    these tables are `posting-command.service.ts`'s idempotency-key lookup, the
    report queries, a demo script and the permission catalogue — all reads, all
    inside accounting. The gate is closed while that is still true, which is the
    only time closing it is free.
  */
  it("has no raw-SQL write to the ledger tables outside the kernel", () => {
    const writers = grep(
      "(INSERT[[:space:]]+INTO|UPDATE|DELETE[[:space:]]+FROM)[[:space:]]+\"?gl_journal",
    ).filter((f) => !f.endsWith(".spec.ts") && !f.endsWith(".e2e-spec.ts"));

    expect(writers.filter((f) => !KERNEL_WRITERS.includes(f))).toEqual([]);
  });

  it("keeps the ledger table names out of raw SQL in every non-accounting module", () => {
    /*
      A read through raw SQL is as much a boundary crossing as a read through
      the schema object — it couples another module to the ledger's column
      names, which is what the ACL exists to prevent.
    */
    const referencing = grep("gl_journals|gl_journal_lines").filter(
      (f) =>
        f.startsWith("modules/") &&
        !f.startsWith("modules/accounting/") &&
        !f.startsWith("modules/rbac/permissions/") &&
        !READ_ONLY_REFERENCES.includes(f),
    );
    expect(referencing).toEqual([]);
  });

  it("fails loudly if the grep itself stops working", () => {
    /*
      `grep()` swallows its own failure and returns `[]`, so a broken pattern,
      a moved `SRC` or a missing `grep` binary would make every `toEqual([])`
      above pass over nothing. This is the floor under all of them: a pattern
      that is known to match must keep matching.
    */
    expect(grep("gl_journals|gl_journal_lines").length).toBeGreaterThan(5);
    expect(grep("\\bglJournalLines\\b").length).toBeGreaterThan(1);
  });
});
