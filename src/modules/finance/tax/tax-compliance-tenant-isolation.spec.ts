import type { Db } from "../../../db/drizzle.module";
import { TaxComplianceService } from "./tax-compliance.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

type ChainResult = Promise<unknown[]> & { limit: jest.Mock; orderBy: jest.Mock; groupBy: jest.Mock };

function makeChainResult(rows: unknown[] = []): ChainResult {
  const p = Promise.resolve(rows) as ChainResult;
  p.limit = jest.fn().mockResolvedValue(rows);
  p.orderBy = jest.fn().mockResolvedValue(rows);
  p.groupBy = jest.fn().mockResolvedValue(rows);
  return p;
}

type ServicePrivate = { daysBetween: (from: string, to: string) => number };

/**
 * checkTaxDue returns [] before touching the database unless a GSTR due date is
 * within DUE_WARNING_DAYS. It computes those due dates in the month AFTER the
 * filing period, so the smallest daysUntilGstr1 the real arithmetic can produce
 * is 11 against a threshold of 5 — the window never opens (measured: 0 of 730
 * consecutive days). An isolation test that does not force the window open never
 * reaches a query and cannot observe org binding at all; that is precisely how
 * the previous version of this file passed while asserting nothing.
 * The unreachability itself is a production defect, characterised by the last
 * test in this file.
 */
function openDueWindow(svc: TaxComplianceService): void {
  jest.spyOn(svc as unknown as ServicePrivate, "daysBetween").mockReturnValue(3);
}

function makeDeps() {
  return {
    dispatch: { sendNotification: jest.fn(), emit: jest.fn().mockResolvedValue(undefined) },
    cache: { cached: jest.fn().mockResolvedValue("PENDING"), set: jest.fn().mockResolvedValue(undefined) },
  };
}

describe("TaxComplianceService — cross-tenant isolation (background sweep)", () => {
  const TARGET_ORG = "org-target";
  const INTRUDER_ORG = "org-intruder";

  it("scopes tax liability computation to the requested org (org isolation)", async () => {
    const allWhereArgs: unknown[] = [];
    const db = {
      select: jest.fn().mockImplementation(() => {
        const where = jest.fn().mockImplementation((arg: unknown) => {
          allWhereArgs.push(arg);
          return makeChainResult([{ cgst: "10", sgst: "10", igst: "0" }]);
        });
        return { from: jest.fn().mockReturnValue({ where, innerJoin: jest.fn().mockReturnValue({ where }) }) };
      }),
    } as unknown as Db;
    const { dispatch, cache } = makeDeps();
    const svc = new TaxComplianceService(db, cache as never, dispatch as never);
    openDueWindow(svc);

    await svc.checkTaxDue(TARGET_ORG);

    expect(allWhereArgs.length).toBeGreaterThan(0);
    const allVals = allWhereArgs.flatMap((w) => sqlValues(w));
    expect(allVals).toContain(TARGET_ORG);
    expect(allVals).not.toContain(INTRUDER_ORG);
  });

  it("emits the due notification only for the requested org (org isolation on the write side)", async () => {
    // computeNetLiability nets output tax (invoices, first select) against input
    // tax (purchase bills, second select); identical rows net to zero and the
    // sweep skips the org, so the two selects must differ for the write path to run.
    let call = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        call += 1;
        const rows = call === 1 ? [{ cgst: "500", sgst: "500", igst: "0" }] : [{ cgst: "0", sgst: "0", igst: "0" }];
        const where = jest.fn().mockReturnValue(makeChainResult(rows));
        return { from: jest.fn().mockReturnValue({ where, innerJoin: jest.fn().mockReturnValue({ where }) }) };
      }),
    } as unknown as Db;
    const { dispatch, cache } = makeDeps();
    const svc = new TaxComplianceService(db, cache as never, dispatch as never);
    openDueWindow(svc);

    const result = await svc.checkTaxDue(TARGET_ORG);

    expect(result).toHaveLength(1);
    expect(result[0]?.orgId).toBe(TARGET_ORG);
    expect(dispatch.emit).toHaveBeenCalledTimes(1);
    expect(dispatch.emit.mock.calls[0]?.[0]).toMatchObject({
      eventKey: "accounting.tax.due",
      orgId: TARGET_ORG,
      entityId: TARGET_ORG,
    });
    expect(JSON.stringify(dispatch.emit.mock.calls)).not.toContain(INTRUDER_ORG);
  });

  it("returns an empty array without dispatching when the org has no net liability (same-tenant control)", async () => {
    const db = {
      select: jest.fn().mockImplementation(() => {
        const where = jest.fn().mockReturnValue(makeChainResult([{ cgst: "0", sgst: "0", igst: "0" }]));
        return { from: jest.fn().mockReturnValue({ where, innerJoin: jest.fn().mockReturnValue({ where }) }) };
      }),
    } as unknown as Db;
    const { dispatch, cache } = makeDeps();
    const svc = new TaxComplianceService(db, cache as never, dispatch as never);
    openDueWindow(svc);

    const result = await svc.checkTaxDue(TARGET_ORG);

    expect(result).toEqual([]);
    expect(dispatch.emit).not.toHaveBeenCalled();
  });

  describe("DEFECT FIN-TAX-WINDOW — the real due window never opens", () => {
    // The clock is pinned to the day BEFORE a GSTR-1 deadline. Correct code
    // would be one day out and inside DUE_WARNING_DAYS; this code puts the
    // deadline in the following month instead, so it is 31 days out and the
    // sweep returns before any query. Without the pin this assertion would be
    // a wall-clock fixture: it happens to hold on most days for the wrong
    // reason, and would decay into passing over a fixed window.
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      jest.setSystemTime(new Date("2026-09-10T00:00:00Z"));
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it("returns [] without reaching the database on the eve of a GSTR-1 deadline", async () => {
      const db = { select: jest.fn() } as unknown as Db;
      const { dispatch, cache } = makeDeps();
      const svc = new TaxComplianceService(db, cache as never, dispatch as never);

      const result = await svc.checkTaxDue(TARGET_ORG);

      expect(result).toEqual([]);
      expect((db as unknown as { select: jest.Mock }).select).not.toHaveBeenCalled();
      expect(dispatch.emit).not.toHaveBeenCalled();
    });
  });
});
