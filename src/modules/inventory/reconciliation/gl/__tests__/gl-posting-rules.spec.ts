import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GL_POSTING_RULES, resolveGlPostingRules } from "../gl-posting-rules";
import { PURPOSE_DEFAULT_CODE } from "../../../../accounting/posting/finance-posting-accounts.service";
import { INVENTORY_JOURNAL_PURPOSES, type InventoryAccountCodes } from "../../../stock-engine/accounting-bridge";

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

  /**
   * A call site may name its purposes through constants, and that is better code
   * than a literal — `purpose: INVENTORY_ACCOUNT` says what the line is for. So
   * the mirror resolves `const NAME = "INVENTORY_ASSET";` in the same file
   * before comparing, rather than demanding a literal and quietly punishing the
   * clearer version. (`landed-cost-apply.service.ts` is the one that does this.)
   */
  function withResolvedPurposes(source: string): string {
    let resolved = source;
    for (const decl of source.matchAll(/const (\w+) = "([A-Z][A-Z_]+)";/g)) {
      const [, name, purpose] = decl;
      if (!name || !purpose) continue;
      resolved = resolved.replace(
        new RegExp(`purpose: ${name}\\b`, "g"),
        `purpose: "${purpose}"`,
      );
    }
    return resolved;
  }

  it("names the same system-account purposes its call site does", () => {
    const sources = inventorySources().map((path) =>
      withResolvedPurposes(readFileSync(path, "utf8")),
    );

    for (const rule of GL_POSTING_RULES) {
      // Every file that posts this event, not the first one found: a second call
      // site for the same event is exactly the drift this test exists to catch,
      // and `find` would have stopped before reaching it. `receive` really does
      // have two — `receipt-journal.ts` and `grn-receive.service.ts` — and this
      // is what holds them to the same entry.
      const callSites = sources.filter((source) =>
        source.includes(`sourceEvent: "${rule.sourceEvent}"`),
      );
      expect(callSites.length).toBeGreaterThan(0);
      for (const callSite of callSites) {
        expect(callSite).toContain(`sourceType: "${rule.sourceType}"`);
        for (const purpose of rule.accountPurposes)
          expect(callSite).toContain(`purpose: "${purpose}"`);
      }
    }
  });

  /**
   * INV-09 — the mirror in the other direction: no call site may name a raw
   * account code any more.
   *
   * The purpose check above passes just as happily on a file that names a
   * purpose on one line and `accountCode: "2000"` on the next, and a single
   * missed line is a journal half of which ignores the tenant's mapping. Only
   * `gl-posting-rules.ts` and the accounting module are allowed to know a number.
   */
  it("leaves no literal account code anywhere in inventory", () => {
    const offenders = inventorySources().filter((path) =>
      /accountCode:\s*"/.test(readFileSync(path, "utf8")),
    );

    expect(offenders).toEqual([]);
  });

  /**
   * Resolution is what turns a purpose back into the codes the report compares
   * against, and it must agree with what posting falls back to for an
   * organisation that has mapped nothing — which is the state every existing
   * tenant is in.
   */
  it("resolves an unmapped organisation to the codes inventory posted before", () => {
    const defaults = Object.fromEntries(
      INVENTORY_JOURNAL_PURPOSES.map((purpose) => [purpose, PURPOSE_DEFAULT_CODE[purpose]]),
    ) as InventoryAccountCodes;

    const byEvent = new Map(
      resolveGlPostingRules(defaults).map((rule) => [rule.sourceEvent, rule.accountCodes]),
    );

    expect(byEvent.get("receive")).toEqual(["1300", "2000"]);
    expect(byEvent.get("ship")).toEqual(["5000", "1300"]);
    // Three purposes, two codes: landed cost debits inventory and COGS and
    // credits the payable, and AP defaults to the same 2000 the receipt's GRNI
    // does. `resolveGlPostingRules` dedupes, because a code listed twice would
    // be looked up twice in `missingCodesExpr` for no gain.
    expect(byEvent.get("apply")).toEqual(["1300", "5000", "2000"]);
  });

  it("keys every rule on a stock reference type, because that is the join", () => {
    // `movement-apply.service.ts` copies the command's `sourceType` onto
    // `inv_stock_transactions.reference_type`, and `postJournalEntry` puts the
    // same string in `journal_entries.source_type`. A rule whose sourceType is
    // not one of those two things reconciles nothing against nothing.
    for (const rule of GL_POSTING_RULES) {
      expect(rule.sourceType).toMatch(/^inv_/);
      expect(rule.accountPurposes.length).toBeGreaterThan(0);
    }
    expect(new Set(GL_POSTING_RULES.map((r) => `${r.sourceType}:${r.sourceEvent}`)).size).toBe(
      GL_POSTING_RULES.length,
    );
  });
});
