import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  planComplianceAttempt,
  stubExternalId,
  STUB_COMPLIANCE_ADAPTER,
  unconfiguredLiveAdapter,
  COMPLIANCE_MAX_ATTEMPTS,
} from "../india-compliance-adapter";
import { IndiaComplianceService } from "../india-compliance.service";

/**
 * E5 — a boundary, not an integration.
 *
 * The properties worth pinning are the ones that stop a rehearsal being mistaken
 * for a filing, and the one that stops a tax integration touching stock.
 */

describe("E5 India compliance boundary", () => {
  describe("the stub is unmistakably a stub", () => {
    it("prefixes its identifiers so no screenshot or export can pass for a filing", async () => {
      const result = await STUB_COMPLIANCE_ADAPTER.register({
        kind: "EINVOICE",
        sourceType: "inv_shipment",
        sourceId: "1",
        documentNumber: "SHP-1",
        payloadHash: "a".repeat(64),
        lines: [],
      });
      expect(result.status).toBe("REGISTERED");
      if (result.status !== "REGISTERED") return;
      // A real IRN is 64 hex characters. This deliberately is not one.
      expect(result.externalId.startsWith("STUB-")).toBe(true);
      expect(/^[0-9a-f]{64}$/i.test(result.externalId)).toBe(false);
    });

    it("reports itself as not live, so the stored row records what it was", () => {
      expect(STUB_COMPLIANCE_ADAPTER.isLive).toBe(false);
    });

    it("derives its id from the payload, so a replay yields the same one", () => {
      expect(stubExternalId("EINVOICE", "deadbeef".repeat(8))).toBe(
        stubExternalId("EINVOICE", "deadbeef".repeat(8)),
      );
      expect(stubExternalId("EINVOICE", "a".repeat(64))).not.toBe(
        stubExternalId("EWAYBILL", "a".repeat(64)),
      );
    });
  });

  describe("a provider that is named but not configured", () => {
    it("refuses loudly rather than falling back to the stub", async () => {
      const adapter = unconfiguredLiveAdapter("nic-ewb");
      const result = await adapter.register({
        kind: "EWAYBILL",
        sourceType: "inv_shipment",
        sourceId: "1",
        documentNumber: "SHP-1",
        payloadHash: "b".repeat(64),
        lines: [],
      });
      expect(result).toMatchObject({ status: "FAILED", code: "NO_CREDENTIALS" });
      // No number of retries conjures a GSP account.
      if (result.status === "FAILED") expect(result.terminal).toBe(true);
    });

    it("still declares itself live, so the failure is not read as a stub outage", () => {
      expect(unconfiguredLiveAdapter("nic-ewb").isLive).toBe(true);
    });
  });

  describe("the retry ladder", () => {
    it("stops retrying exactly when the schedule runs out", () => {
      let attempts = 0;
      let plan = planComplianceAttempt({ attempts, ok: false });
      while (!plan.deadLettered && attempts < 10) {
        attempts = plan.attempts;
        plan = planComplianceAttempt({ attempts, ok: false });
      }
      expect(plan.attempts).toBe(COMPLIANCE_MAX_ATTEMPTS);
      expect(plan.deadLettered).toBe(true);
    });

    it("does not retry a terminal failure — that turns one wrong answer into three", () => {
      const plan = planComplianceAttempt({ attempts: 0, ok: false, terminal: true });
      expect(plan.retryInMs).toBeNull();
      expect(plan.deadLettered).toBe(true);
    });

    it("stops immediately on success", () => {
      expect(planComplianceAttempt({ attempts: 0, ok: true })).toEqual({
        attempts: 1,
        retryInMs: null,
        deadLettered: false,
      });
    });
  });

  describe("the payload hash", () => {
    const base = {
      kind: "EINVOICE" as const,
      sourceType: "inv_shipment",
      sourceId: "7",
      documentNumber: "SHP-7",
      lines: [
        { description: "Widget", hsnCode: "8471", quantity: "2.0000", taxableValue: "200.00" },
        { description: "Gadget", hsnCode: "8473", quantity: "1.0000", taxableValue: "150.00" },
      ],
    };

    it("does not change when the lines arrive in a different order", () => {
      const reversed = { ...base, lines: [...base.lines].reverse() };
      expect(IndiaComplianceService.payloadHash(base)).toBe(
        IndiaComplianceService.payloadHash(reversed),
      );
    });

    it("changes when a quantity or a value changes, so an amendment is a new document", () => {
      const amended = {
        ...base,
        lines: [{ ...base.lines[0]!, quantity: "3.0000" }, base.lines[1]!],
      };
      expect(IndiaComplianceService.payloadHash(amended)).not.toBe(
        IndiaComplianceService.payloadHash(base),
      );
    });

    it("changes when the HSN code changes — the thing being taxed is different", () => {
      const reclassified = {
        ...base,
        lines: [{ ...base.lines[0]!, hsnCode: "9999" }, base.lines[1]!],
      };
      expect(IndiaComplianceService.payloadHash(reclassified)).not.toBe(
        IndiaComplianceService.payloadHash(base),
      );
    });
  });

  describe("the ledger is out of reach by construction", () => {
    it("neither compliance file imports the stock engine, a reservation or a journal", () => {
      // The unit's hardest requirement is "flag on + stub: shipment stores an
      // IRN, ledger unchanged". Asserting that with a mock proves one code path;
      // asserting the import graph proves there is no path at all.
      const dir = join(__dirname, "..");
      const forbidden = [
        "stock-engine.service",
        "reservation.service",
        "movement-apply",
        "JournalPostingService",
        "journal-posting",
      ];
      for (const file of ["india-compliance.service.ts", "india-compliance-adapter.ts"]) {
        const source = readFileSync(join(dir, file), "utf8");
        const imports = source
          .split("\n")
          .filter((line) => line.trimStart().startsWith("import"))
          .join("\n");
        for (const banned of forbidden) {
          expect(imports).not.toContain(banned);
        }
      }
    });
  });
});
