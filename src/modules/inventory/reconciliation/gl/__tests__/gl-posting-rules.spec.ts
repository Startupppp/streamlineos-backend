import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GL_POSTING_RULES, accountTagsOf, resolveGlPostingRules } from "../gl-posting-rules";
import {
  INVENTORY_PURPOSE_TAG,
  type InventoryAccountCodes,
} from "../../../stock-engine/accounting-bridge";
import { POSTING_PURPOSE_BY_REFERENCE } from "../../../../accounting/adapters/reconciliation/unposted-movements.service";

/**
 * D6 — the reconciliation's expectations against the code that creates them.
 *
 * `GL_POSTING_RULES` is a hand-kept mirror of the call sites, because no third
 * place knows both the stock reference type and the journal's posting purpose.
 * A mirror that drifts is worse than no mirror: a post the rules do not list
 * vanishes from the report, and the report says everything reconciles.
 *
 * Since the accounting rewrite inventory posts in two vocabularies, and the
 * mirror has to read both:
 *
 *   through InventoryAccountingBridge — a draft naming `sourceType`,
 *     `sourceEvent` and purposes (receipt-journal, landed-cost-journal);
 *   through PostingCommandService directly — a `stock_move` command naming a
 *     `purpose` and account roles (grn-receive, so-fulfillment).
 */

function inventorySources(): string[] {
  const root = join(__dirname, "..", "..", "..");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return entry === "node_modules" ? [] : walk(path);
      if (!path.endsWith(".ts") || path.includes("spec.ts")) return [];
      // The rules table itself names every event, so leaving it in the scan
      // makes the mirror check find itself and pass by tautology.
      if (path.endsWith("gl-posting-rules.ts")) return [];
      // The bridge posts every draft generically, and `lib/journal-vocabulary.ts`
      // DECLARES the closed set of draft sources as a type (it moved there when
      // the bridge split). The call sites that post under them are what is being
      // mirrored.
      if (path.endsWith(join("stock-engine", "accounting-bridge.ts"))) return [];
      if (path.endsWith(join("stock-engine", "lib", "journal-vocabulary.ts"))) return [];
      return [path];
    });
  return walk(root);
}

/** Every `this.posting.submit(` command object in a file, isolated by brace matching. */
function submitCommands(source: string): string[] {
  const commands: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf("this.posting.submit(", from);
    if (at === -1) return commands;
    const open = source.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          commands.push(source.slice(open, i + 1));
          break;
        }
      }
    }
    from = at + 1;
  }
}

/** Stock journals only. The sales invoice (`sales_invoice`) books revenue and no movement produces it. */
function stockMoveCommands(source: string): string[] {
  return submitCommands(source).filter((command) => command.includes('sourceType: "stock_move"'));
}

/**
 * A call site may name its purposes through constants, which is better code
 * than a literal. So `const NAME = "INVENTORY_ASSET";` is resolved in the same
 * file before comparing (`landed-cost-journal.ts` does this).
 */
function withResolvedPurposes(source: string): string {
  let resolved = source;
  for (const decl of source.matchAll(/const (\w+) = "([A-Z][A-Z_]+)";/g)) {
    const [, name, purpose] = decl;
    if (!name || !purpose) continue;
    resolved = resolved.replace(new RegExp(`purpose: ${name}\\b`, "g"), `purpose: "${purpose}"`);
  }
  return resolved;
}

const SOURCES = inventorySources().map((path) => ({
  path,
  source: withResolvedPurposes(readFileSync(path, "utf8")),
}));

function postedEvents(): Set<string> {
  const found = new Set<string>();
  for (const { source } of SOURCES) {
    for (const match of source.matchAll(/sourceEvent:\s*"([^"]+)"/g)) found.add(match[1]!);
    for (const command of stockMoveCommands(source)) {
      const purpose = /purpose:\s*"([a-z_]+)"/.exec(command)?.[1];
      if (purpose) found.add(purpose);
    }
  }
  return found;
}

const CHART: InventoryAccountCodes = {
  INVENTORY_ASSET: "1300",
  INVENTORY_COGS: "5000",
  INVENTORY_GRNI: "2000",
  AP: "2000",
  AR: "1200",
  SALES_INCOME: "4000",
};

describe("inventory GL posting rules", () => {
  it("lists a rule for every journal inventory posts off a stock document", () => {
    const events = postedEvents();
    // Anti-vacuity: both vocabularies were read.
    expect(events).toContain("receive");
    expect(events).toContain("ship");

    const unaccounted = [...events].filter(
      (event) => !GL_POSTING_RULES.some((rule) => rule.sourceEvent === event),
    );
    expect(unaccounted).toEqual([]);
  });

  it("names the same roles its call sites do, in either vocabulary", () => {
    for (const rule of GL_POSTING_RULES) {
      const drafts = SOURCES.filter(({ source }) =>
        source.includes(`sourceEvent: "${rule.sourceEvent}"`),
      );
      for (const { path, source } of drafts) {
        expect({ path, ok: source.includes(`sourceType: "${rule.sourceType}"`) }).toEqual({ path, ok: true });
        for (const purpose of rule.accountPurposes)
          expect({ path, purpose, ok: source.includes(`purpose: "${purpose}"`) }).toEqual({ path, purpose, ok: true });
      }

      const commands = SOURCES.flatMap(({ path, source }) =>
        stockMoveCommands(source)
          .filter((command) => command.includes(`purpose: "${rule.sourceEvent}"`))
          .map((command) => ({ path, command })),
      );
      for (const { path, command } of commands) {
        for (const tag of accountTagsOf(rule.accountPurposes))
          expect({ path, tag, ok: command.includes(`accountTag: "${tag}"`) }).toEqual({ path, tag, ok: true });
      }

      expect(drafts.length + commands.length).toBeGreaterThan(0);
    }
  });

  it("holds both receipt paths to the one receipt entry", () => {
    // `receive` really has two call sites — the two-phase post through the
    // bridge and the one-shot receive direct — and they share one key.
    const draftSites = SOURCES.filter(({ source }) => source.includes('sourceEvent: "receive"'));
    const commandSites = SOURCES.filter(({ source }) =>
      stockMoveCommands(source).some((command) => command.includes('purpose: "receive"')),
    );
    expect(draftSites.map(({ path }) => path.split("inventory/")[1])).toEqual([
      "purchase-orders/lib/receipt-journal.ts",
    ]);
    expect(commandSites.map(({ path }) => path.split("inventory/")[1])).toEqual([
      "purchase-orders/grn-receive.service.ts",
    ]);
  });

  it("leaves no literal account code or account id anywhere in inventory", () => {
    const offenders = SOURCES.filter(({ source }) => /account(Code|Id):\s*"/.test(source)).map(
      ({ path }) => path,
    );
    expect(offenders).toEqual([]);
  });

  it("resolves an organisation's roles to the codes of the accounts carrying them", () => {
    const byEvent = new Map(
      resolveGlPostingRules(CHART).map((rule) => [rule.sourceEvent, rule]),
    );

    expect(byEvent.get("receive")?.accountCodes).toEqual(["1300", "2000"]);
    expect(byEvent.get("ship")?.accountCodes).toEqual(["5000", "1300"]);
    // Three purposes, two roles' worth of payable: AP and GRNI both resolve to
    // ap_control, so the codes dedupe.
    expect(byEvent.get("landed_cost")?.accountCodes).toEqual(["1300", "5000", "2000"]);
    for (const rule of byEvent.values()) expect(rule.missingAccountTags).toEqual([]);
  });

  it("names a role no account fills as missing, rather than inventing a code", () => {
    const receive = resolveGlPostingRules({ ...CHART, INVENTORY_ASSET: null }).find(
      (rule) => rule.sourceEvent === "receive",
    );
    expect(receive?.accountCodes).toEqual(["2000"]);
    expect(receive?.missingAccountTags).toEqual(["inventory"]);
  });

  it("states every rule in the roles the bridge resolves", () => {
    for (const rule of resolveGlPostingRules(CHART)) {
      expect(rule.accountTags).toEqual(accountTagsOf(rule.accountPurposes));
      for (const purpose of rule.accountPurposes) expect(INVENTORY_PURPOSE_TAG[purpose]).toBeDefined();
    }
  });

  it("keys every rule on a stock reference type, and every key is distinct", () => {
    for (const rule of GL_POSTING_RULES) {
      expect(rule.sourceType).toMatch(/^inv_/);
      expect(["reference", "shipment"]).toContain(rule.keyedOn);
      expect(rule.accountPurposes.length).toBeGreaterThan(0);
    }
    expect(new Set(GL_POSTING_RULES.map((r) => `${r.sourceType}:${r.sourceEvent}`)).size).toBe(
      GL_POSTING_RULES.length,
    );
    expect(new Set(GL_POSTING_RULES.map((r) => r.sourceEvent)).size).toBe(GL_POSTING_RULES.length);
  });

  it("agrees with the accounting module about the one reference type both reconcile", () => {
    // The kernel's unposted-movements report owns the stock-bridge kinds. Where
    // a reference type appears in both lists, the purpose must be the same or
    // the two reports would look for different journals.
    const shared = GL_POSTING_RULES.filter((rule) => rule.sourceType in POSTING_PURPOSE_BY_REFERENCE);
    expect(shared.map((rule) => rule.sourceType)).toEqual(["inv_grn"]);
    for (const rule of shared) {
      expect(POSTING_PURPOSE_BY_REFERENCE[rule.sourceType]).toBe(rule.sourceEvent);
    }
  });
});
