import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isCoreModuleKey } from "../../../../common/rbac/module-registry";
import { AdapterRejection } from "../../../accounting/adapters/posting-command.types";

const repoSrc = join(__dirname, "..", "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(repoSrc, ...parts), "utf8");

/**
 * INV-07 — the decision, and the facts it rests on, as they stand on the
 * accounting kernel.
 *
 * The ticket's acceptance is "an enabled tenant cannot post with an unmapped
 * account". There were two ways to meet it:
 *
 *   at posting time — refuse the movement. The legacy inventory bridge
 *     rejected this and warned and skipped instead, arguing that a goods receipt
 *     is a physical fact. The accounting rewrite reversed that. Its contract
 *     (`docs/inventory-gl-contract.md` §4, ACC-06) is fail-closed: on a tenant
 *     that has enabled accounting, a stock change the ledger will not accept
 *     does not happen, because the alternative is a balance sheet silently
 *     wrong by the value of every unmapped movement. Only `BOOK_NOT_ENABLED`
 *     skips. This file now pins THAT.
 *
 *   at setup time — refuse to switch accounting on until the roles are mapped.
 *     Still not the mechanism. The second section below keeps the facts that
 *     make a setup-time gate a deadlock rather than a gate, retargeted at the
 *     kernel's role-mapping endpoint.
 */
describe("INV-07 — inventory posting with an unmapped role", () => {
  describe("the decision: refuse on an enabled tenant, skip only where accounting is off", () => {
    const bridge = read("modules", "inventory", "stock-engine", "accounting-bridge.ts");

    it("swallows BOOK_NOT_ENABLED and rethrows everything else", () => {
      const swallowed = [...bridge.matchAll(/error\.code === "([A-Z_]+)"/g)].map((m) => m[1]);
      expect(swallowed).toEqual(["BOOK_NOT_ENABLED"]);
      expect(bridge).toMatch(
        /error\.code === "BOOK_NOT_ENABLED"\) \{[\s\S]*?return;\s*\}\s*throw error;/,
      );
    });

    it("no longer warns and skips, or probes for tables", () => {
      // Calls, not words: the class comment explains what it used to do.
      expect(bridge).not.toMatch(/logger\.warn\(/);
      expect(bridge).not.toMatch(/to_regclass\(/);
      expect(bridge).not.toMatch(/\bledgerAccounts\b/);
    });

    it("routes every inventory journal through PostingCommandService, so the refusal is uniform", () => {
      // A refusal that only some paths implement is the worst of both answers:
      // the tenant cannot tell from the outcome whether a document posted.
      const callSites: Array<[string[], RegExp]> = [
        [["modules", "inventory", "purchase-orders", "lib", "receipt-journal.ts"], /\.postJournalEntry\(/],
        [["modules", "inventory", "landed-cost", "lib", "landed-cost-journal.ts"], /\.postJournalEntry\(/],
        [["modules", "inventory", "purchase-orders", "grn-receive.service.ts"], /this\.posting\.submit\(/],
        [["modules", "inventory", "sales-orders", "so-fulfillment.service.ts"], /this\.posting\.submit\(/],
        [["modules", "inventory", "sales-orders", "so-lifecycle.service.ts"], /this\.posting\.submit\(/],
      ];

      for (const [parts, call] of callSites) {
        const source = read(...parts);
        expect(source).toMatch(call);
        expect(source).not.toMatch(/\.persistJournalEntry\(/);
        expect(source).not.toContain("LedgerService");
        // A direct caller swallows the same one code the bridge does, and no other.
        for (const match of source.matchAll(/error\.code === "([A-Z_]+)"/g)) {
          expect(match[1]).toBe("BOOK_NOT_ENABLED");
        }
      }
      expect(bridge).toMatch(/this\.posting\.submit\(/);
    });

    it("answers an unmapped role with a 409 an operator can act on, not a 500", () => {
      expect(new AdapterRejection("UNKNOWN_ACCOUNT_TAG", 'No account is tagged "inventory"').getStatus()).toBe(409);
    });
  });

  describe("why the refusal is at posting time and not a setup-time gate", () => {
    it("finds a real per-tenant accounting switch", () => {
      // Plan-gated means not core, and only a non-core module has an
      // `org_modules` row that can be off.
      expect(isCoreModuleKey("accounting")).toBe(false);

      const entitlements = read("modules", "access", "entitlements.service.ts");
      expect(entitlements).toContain("async setModuleEnabled(");
      expect(entitlements).toContain("insert(orgModules)");
    });

    it("finds the role-mapping endpoint gated on that same switch — the deadlock", () => {
      // Mapping a role requires accounting enabled; gating "accounting enabled"
      // on the mappings would make both unreachable forever.
      const controller = read("modules", "accounting", "kernel", "kernel.controller.ts");
      expect(controller).toContain('@RequireModule("accounting")');
      expect(controller).toContain("accounts/:accountId/system-tag");
      expect(controller).toContain("setSystemTag");
    });

    it("finds org creation bypassing the switch entirely", () => {
      const provision = read("common", "org", "provision-org-modules.ts");
      expect(provision).toContain("insert(orgModules)");
      expect(provision).not.toContain("setModuleEnabled");

      for (const parts of [
        ["modules", "organization", "setup", "org-setup.service.ts"],
        ["modules", "auth", "auth.service.ts"],
      ]) {
        expect(read(...parts)).toContain("provisionOrgModules");
      }
    });
  });
});
