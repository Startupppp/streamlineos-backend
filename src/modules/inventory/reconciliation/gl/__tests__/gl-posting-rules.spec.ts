import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GL_POSTING_RULES } from "../gl-posting-rules";

/**
 * D6 — the reconciliation's expectations against the code that creates them.
 *
 * `GL_POSTING_RULES` is a hand-kept mirror of three call sites, because there is
 * no third place that knows both the stock reference type and the journal source
 * event. A mirror that drifts is worse than no mirror: a posting the rules do
 * not list simply vanishes from the report, and the report says everything
 * reconciles.
 *
 * So the drift is caught here rather than in production. Every `sourceEvent`
 * inventory posts must be either a rule or a deliberate exclusion, and every
 * rule's account codes must be the codes its call site actually names.
 */

/** `invoice` books revenue off a sales order; no stock movement produces it. */
const DELIBERATELY_NOT_RECONCILED = new Set(["invoice"]);

function inventorySources(): string[] {
  const root = join(__dirname, "..", "..", "..");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return entry === "node_modules" ? [] : walk(path);
      if (!path.endsWith(".ts") || path.includes("spec.ts")) return [];
      // The rules table itself literally contains `sourceEvent: "ship"`, so
      // leaving it in the scan makes the mirror check find itself and pass by
      // tautology. It is the thing being verified, not evidence for it.
      if (path.endsWith("gl-posting-rules.ts")) return [];
      return [path];
    });
  return walk(root);
}

function postedEvents(): Set<string> {
  const found = new Set<string>();
  for (const path of inventorySources()) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/sourceEvent:\s*"([^"]+)"/g)) {
      const event = match[1];
      if (event) found.add(event);
    }
  }
  return found;
}

describe("inventory GL posting rules", () => {
  it("lists a rule for every journal inventory posts off a stock movement", () => {
    const unaccounted = [...postedEvents()].filter(
      (event) =>
        !DELIBERATELY_NOT_RECONCILED.has(event) &&
        !GL_POSTING_RULES.some((rule) => rule.sourceEvent === event),
    );

    expect(unaccounted).toEqual([]);
  });

  it("names the same account codes its call site does", () => {
    const sources = inventorySources().map((path) => readFileSync(path, "utf8"));

    for (const rule of GL_POSTING_RULES) {
      // Every file that posts this event, not the first one found: a second call
      // site for the same event is exactly the drift this test exists to catch,
      // and `find` would have stopped before reaching it.
      const callSites = sources.filter((source) =>
        source.includes(`sourceEvent: "${rule.sourceEvent}"`),
      );
      expect(callSites.length).toBeGreaterThan(0);
      for (const callSite of callSites) {
        expect(callSite).toContain(`sourceType: "${rule.sourceType}"`);
        for (const code of rule.accountCodes)
          expect(callSite).toContain(`accountCode: "${code}"`);
      }
    }
  });

  it("keys every rule on a stock reference type, because that is the join", () => {
    // `movement-apply.service.ts` copies the command's `sourceType` onto
    // `inv_stock_transactions.reference_type`, and `postJournalEntry` puts the
    // same string in `journal_entries.source_type`. A rule whose sourceType is
    // not one of those two things reconciles nothing against nothing.
    for (const rule of GL_POSTING_RULES) {
      expect(rule.sourceType).toMatch(/^inv_/);
      expect(rule.accountCodes.length).toBeGreaterThan(0);
    }
    expect(new Set(GL_POSTING_RULES.map((r) => `${r.sourceType}:${r.sourceEvent}`)).size).toBe(
      GL_POSTING_RULES.length,
    );
  });
});
