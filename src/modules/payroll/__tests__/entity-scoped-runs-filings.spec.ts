/**
 * Phase 10.2 — entity-scoped runs/filings contracts.
 * Isolation + schema + pure registry helpers (no full Nest DI).
 */
import {
  assertEntityCountryIsolation,
  describeCountryPack,
} from "../../hr/global/lib/country-pack-registry";
import { IN_STATUTORY_RULE_BUNDLE_VERSION } from "../runs/lib/statutory-registry";
import {
  createRunSchema,
  listRunsQuerySchema,
} from "../runs/dto/runs.schemas";

describe("Phase 10.2 entity-scoped runs/filings", () => {
  describe("country isolation", () => {
    it("allows matching country codes", () => {
      expect(assertEntityCountryIsolation("IN", "IN").ok).toBe(true);
      expect(assertEntityCountryIsolation("ae", "AE").ok).toBe(true);
    });

    it("blocks cross-country contamination", () => {
      const check = assertEntityCountryIsolation("IN", "AE");
      expect(check.ok).toBe(false);
      expect(check.message).toMatch(/cannot apply AE/i);
    });
  });

  describe("country pack statutory bundle", () => {
    it("India pack links IN-2025.04 production baseline", () => {
      const pack = describeCountryPack("IN");
      expect(pack?.maturity).toBe("production_baseline");
      expect(pack?.payrollStatutoryBundle).toBe(IN_STATUTORY_RULE_BUNDLE_VERSION);
    });

    it("pilot packs do not claim full payroll statutory engines", () => {
      for (const code of ["AE", "SG", "US"] as const) {
        const pack = describeCountryPack(code);
        expect(pack?.maturity).toBe("pilot");
        expect(pack?.payrollStatutoryBundle).toBeNull();
        expect(pack?.honestyLabel.toLowerCase()).toMatch(/pilot|not full local payroll/);
      }
    });
  });

  describe("createRunSchema entityId", () => {
    it("accepts optional entityId", () => {
      const ok = createRunSchema.safeParse({
        month: "2026-07",
        entityId: 12,
      });
      expect(ok.success).toBe(true);
      if (ok.success) {
        expect(ok.data.entityId).toBe(12);
        expect(ok.data.runType).toBe("REGULAR");
      }
    });

    it("rejects non-positive entityId", () => {
      expect(createRunSchema.safeParse({ month: "2026-07", entityId: 0 }).success).toBe(
        false,
      );
    });
  });

  describe("listRunsQuerySchema entityId filter", () => {
    it("coerces entityId from query string", () => {
      const ok = listRunsQuerySchema.safeParse({ page: "1", limit: "20", entityId: "5" });
      expect(ok.success).toBe(true);
      if (ok.success) expect(ok.data.entityId).toBe(5);
    });

    it("allows list without entityId", () => {
      const ok = listRunsQuerySchema.safeParse({});
      expect(ok.success).toBe(true);
      if (ok.success) expect(ok.data.entityId).toBeUndefined();
    });
  });

  describe("multi-entity run uniqueness (contract)", () => {
    /**
     * Mirrors RunsService.createRun existence key after migration 0298:
     * unique on (org, month, runType, COALESCE(entityId, 0)).
     */
    function runKey(
      orgId: string,
      month: string,
      runType: string,
      entityId: number | null,
    ): string {
      return `${orgId}|${month}|${runType}|${entityId ?? 0}`;
    }

    it("allows same month REGULAR for different entities", () => {
      const a = runKey("org1", "2026-07", "REGULAR", 1);
      const b = runKey("org1", "2026-07", "REGULAR", 2);
      expect(a).not.toBe(b);
    });

    it("collides when same entity + month + type", () => {
      const a = runKey("org1", "2026-07", "REGULAR", 5);
      const b = runKey("org1", "2026-07", "REGULAR", 5);
      expect(a).toBe(b);
    });

    it("treats null entity as a single org-level bucket", () => {
      const a = runKey("org1", "2026-07", "REGULAR", null);
      const b = runKey("org1", "2026-07", "REGULAR", null);
      const withEntity = runKey("org1", "2026-07", "REGULAR", 1);
      expect(a).toBe(b);
      expect(a).not.toBe(withEntity);
    });
  });

  describe("filing entity isolation rules (contract)", () => {
    /**
     * Mirrors PayrollFilingsService.prepareExport guards without DB:
     * - non-IN entity rejected for India export builders
     * - run.entityId mismatch rejected
     */
    function assertFilingEntityAllowed(opts: {
      entityCountry: string;
      ruleVersion?: string;
      runEntityId?: number | null;
      requestEntityId?: number | null;
    }): { ok: true } | { ok: false; reason: string } {
      const country = opts.entityCountry.toUpperCase();
      if (country !== "IN") {
        return {
          ok: false,
          reason: `India statutory export builders cannot prepare filings for entity country ${country}`,
        };
      }
      if (opts.ruleVersion) {
        const ruleCountry = opts.ruleVersion.split("-")[0] ?? "";
        if (ruleCountry.length === 2) {
          const isolation = assertEntityCountryIsolation(opts.entityCountry, ruleCountry);
          if (!isolation.ok) return { ok: false, reason: isolation.message };
        }
      }
      if (
        opts.runEntityId != null &&
        opts.requestEntityId != null &&
        opts.runEntityId !== opts.requestEntityId
      ) {
        return {
          ok: false,
          reason: `Run belongs to entity ${opts.runEntityId}, not entity ${opts.requestEntityId}`,
        };
      }
      return { ok: true };
    }

    it("allows India entity + IN rule bundle", () => {
      expect(
        assertFilingEntityAllowed({
          entityCountry: "IN",
          ruleVersion: IN_STATUTORY_RULE_BUNDLE_VERSION,
          runEntityId: 1,
          requestEntityId: 1,
        }).ok,
      ).toBe(true);
    });

    it("rejects AE entity for India filing builders", () => {
      const r = assertFilingEntityAllowed({ entityCountry: "AE" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/AE/);
    });

    it("rejects cross-entity run binding", () => {
      const r = assertFilingEntityAllowed({
        entityCountry: "IN",
        runEntityId: 2,
        requestEntityId: 9,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/entity 2/);
    });

    it("rejects non-IN ruleVersion contamination", () => {
      const r = assertFilingEntityAllowed({
        entityCountry: "IN",
        ruleVersion: "AE-2025.01",
      });
      expect(r.ok).toBe(false);
    });
  });
});
