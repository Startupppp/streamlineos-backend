import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isCoreModuleKey } from "../../../../common/rbac/module-registry";

const repoSrc = join(__dirname, "..", "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(repoSrc, ...parts), "utf8");

/**
 * INV-07 — the decision, and the three measurements it rests on.
 *
 * The ticket's acceptance is "an enabled tenant cannot post with an unmapped
 * account". Two ways to meet it:
 *
 *   at posting time — refuse the movement. Rejected. A goods receipt is a
 *     physical fact that already happened; refusing to record it because nobody
 *     set up account 1300 moves the warehouse's records further from the truth,
 *     not closer. `InventoryAccountingBridge.postJournalEntry` warns and skips,
 *     and `gl-recon` is what makes the resulting gap countable. This file pins
 *     that it stays a skip.
 *
 *   at setup time — refuse to switch accounting **on** until the six inventory
 *     purposes are mapped, making "enabled ⇒ mapped" true by construction.
 *     Recommended in the audit, and **not buildable here**. The three facts
 *     below are why, and each is asserted rather than asserted-about, so that if
 *     any of them changes the decision gets re-opened instead of quietly
 *     surviving on a stale argument.
 *
 * The reason a setup-time gate cannot exist today is a circularity:
 *
 *   1. `accounting` is plan-gated, so it is a real per-tenant toggle in
 *      `org_modules` — the audit's "enablement exists only in the main
 *      backend's AccountingSetupService" is wrong for this tree. There is a
 *      switch. `EntitlementsService.setModuleEnabled` is it.
 *   2. But the endpoint that writes a mapping is `@RequireModule("accounting")`.
 *      An organisation cannot map a purpose until accounting is enabled.
 *   3. So gating (1) on the mappings from (2) means accounting can never be
 *      enabled by anyone, ever. Not a strict gate — a deadlock.
 *
 * And even a gate that worked would not hold, because org creation writes
 * `org_modules` through `provisionOrgModules` directly and never passes through
 * `setModuleEnabled` at all.
 *
 * The half-gate — "cannot enable *inventory* while accounting is on unless the
 * six are mapped" — does not deadlock, and was rejected for being worse than
 * nothing: it reads as the invariant "enabled ⇒ mapped" while an organisation
 * that had inventory on first and enabled accounting afterwards walks straight
 * past it. The symmetric half is the one that deadlocks.
 */
describe("INV-07 — inventory posting with an unmapped or missing account", () => {
  describe("the decision: skip, not refuse", () => {
    const bridge = read("modules", "inventory", "stock-engine", "accounting-bridge.ts");

    it("warns and returns rather than throwing when an account is absent", () => {
      // The behavioural assertion lives in
      // `accounting-bridge-account-resolution.spec.ts` ("still records the
      // receipt and skips the journal"). This is the structural half: no throw
      // was introduced on the missing-account path.
      const missingBranch = bridge.slice(bridge.indexOf("if (missing.length > 0)"));
      const branchBody = missingBranch.slice(0, missingBranch.indexOf("await this.journals"));
      expect(branchBody).toContain("this.logger.warn");
      expect(branchBody).not.toContain("throw ");
    });

    it("routes every inventory journal through the bridge, so the skip is uniform", () => {
      // Two call sites used to reach past it to `persistJournalEntry`, which
      // throws "Seed COA first" — a partial, accidental refusal that fired after
      // the shipment or receipt had already committed. A refusal that only some
      // paths implement is the worst of both answers.
      const callSites = [
        ["modules", "inventory", "purchase-orders", "lib", "receipt-journal.ts"],
        ["modules", "inventory", "purchase-orders", "grn-receive.service.ts"],
        ["modules", "inventory", "sales-orders", "so-fulfillment.service.ts"],
        ["modules", "inventory", "sales-orders", "so-lifecycle.service.ts"],
        // Moved out of `landed-cost-apply.service.ts` by cf85d67fa; the list
        // follows the CALL, which is the thing this test is about.
        ["modules", "inventory", "landed-cost", "lib", "landed-cost-journal.ts"],
      ];

      for (const parts of callSites) {
        const source = read(...parts);
        expect(source).toMatch(/\.postJournalEntry\(/);
        // The *call*, not the word: two of these files name
        // `persistJournalEntry` in a comment explaining why they stopped calling
        // it, and banning the string would forbid the explanation.
        expect(source).not.toMatch(/\.persistJournalEntry\(/);
      }
    });
  });

  describe("why the setup-time gate the audit recommended is not buildable", () => {
    it("finds a real per-tenant accounting switch, contradicting the audit", () => {
      // Plan-gated means not core, and only a non-core module has an
      // `org_modules` row that can be off. If this ever became core the switch
      // would vanish and this whole section would need rewriting.
      expect(isCoreModuleKey("accounting")).toBe(false);

      const entitlements = read("modules", "access", "entitlements.service.ts");
      expect(entitlements).toContain("async setModuleEnabled(");
      expect(entitlements).toContain("insert(orgModules)");
    });

    it("finds the mapping endpoint gated on that same switch — the deadlock", () => {
      const controller = read(
        "modules",
        "accounting",
        "settings",
        "system-accounts.controller.ts",
      );

      // This is the whole argument in one assertion. Mapping requires accounting
      // enabled; gating "accounting enabled" on the mappings makes both
      // unreachable forever.
      expect(controller).toContain('@RequireModule("accounting")');
      expect(controller).toContain("upsertSystemAccount");
    });

    it("finds org creation bypassing the switch entirely", () => {
      // Even a gate that somehow avoided the deadlock would not hold: two
      // creation paths write `org_modules` through `provisionOrgModules`, which
      // inserts directly and never consults `setModuleEnabled`.
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
