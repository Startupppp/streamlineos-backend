import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { PayslipBulkPublisherService } from "./payslip-bulk-publisher.service";
import { PublishingService } from "./publishing.service";

jest.mock("../lib/payroll-run-payee", () => ({
  ...jest.requireActual("../lib/payroll-run-payee"),
  loadRunEmployeePayees: jest.fn(),
}));
jest.mock("../dto/payroll.schemas", () => ({
  ...jest.requireActual("../dto/payroll.schemas"),
  toCalculationSnapshot: (value: unknown) => value,
  normalizePayrollToggles: () => ({}),
}));
jest.mock("./lib/payslip-renderer", () => ({ buildPayslipPdfData: () => ({}) }));
jest.mock("../hr-payroll/lib/payslip-pdf", () => ({
  generatePayslipPdf: jest.fn().mockResolvedValue(Buffer.from("pdf")),
}));

import { loadRunEmployeePayees } from "../lib/payroll-run-payee";

const ORG_ID = "org-owner";
const OTHER_ORG = "org-other";
const RUN_ID = 7;
const ACTOR = "user-actor";

function payee(runEmployeeId: number) {
  return {
    runEmployeeId,
    subjectKey: `user:${runEmployeeId}`,
    displayName: `Person ${runEmployeeId}`,
    subject: { userId: null, workerId: null },
    bankDetails: null,
    email: null,
  };
}

function makePublisherDb(status: string, runEmployees: { id: number; holdReason: string | null }[], finalPubs: unknown[]) {
  const inserted: Record<string, unknown>[] = [];
  const transaction = jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
      insert: () => ({ values: () => Promise.resolve([]) }),
    }),
  );
  const db = {
    query: {
      payrollRuns: { findFirst: jest.fn().mockResolvedValue({ id: RUN_ID, orgId: ORG_ID, status, month: "2026-08", policyVersion: null }) },
      payslipTemplates: { findFirst: jest.fn().mockResolvedValue(null) },
      organizations: { findFirst: jest.fn().mockResolvedValue({ name: "Acme", address: null }) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: "m-1" }) },
      payslipPublications: { findMany: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(finalPubs) },
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve(
              runEmployees.map((row) => ({ ...row, calculationSnapshot: { net: 1 }, workerType: "EMPLOYEE", currency: "INR" })),
            ),
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return { onConflictDoUpdate: () => ({ returning: () => Promise.resolve([{ id: 100 + inserted.length }]) }) };
      },
    }),
    transaction,
  } as unknown as Db;
  return { db, inserted, transaction };
}

function makePublisher(db: Db) {
  return new PayslipBulkPublisherService(
    db,
    { log: jest.fn() } as never,
    { isConfigured: () => false } as never,
    { notifyPayslipPublished: jest.fn() } as never,
    { emit: jest.fn() } as never,
    {} as never,
  );
}

describe("PayslipBulkPublisherService — held payslips", () => {
  beforeEach(() => {
    (loadRunEmployeePayees as jest.Mock).mockResolvedValue([payee(1), payee(2)]);
  });

  it("bulk publish skips a held employee, reports it, and still reaches PAYSLIPS_PUBLISHED", async () => {
    const { db, inserted, transaction } = makePublisherDb(
      "PAID",
      [{ id: 1, holdReason: null }, { id: 2, holdReason: "Exit pending" }],
      [{ runEmployeeId: 1, status: "PUBLISHED" }],
    );

    const result = await makePublisher(db).publish(ORG_ID, RUN_ID, ACTOR);

    expect(inserted.map((row) => row.runEmployeeId)).toEqual([1]);
    expect(result).toEqual({ published: 1, total: 1, heldCount: 1, runStatus: "PAYSLIPS_PUBLISHED" });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("does not transition when every employee is held", async () => {
    const { db, inserted, transaction } = makePublisherDb(
      "PAID",
      [{ id: 1, holdReason: "a" }, { id: 2, holdReason: "b" }],
      [],
    );

    const result = await makePublisher(db).publish(ORG_ID, RUN_ID, ACTOR);

    expect(inserted).toHaveLength(0);
    expect(result).toEqual({ published: 0, total: 0, heldCount: 2, runStatus: "PAID" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("publishes a released employee on an already-published run without re-transitioning", async () => {
    const { db, inserted, transaction } = makePublisherDb(
      "PAYSLIPS_PUBLISHED",
      [{ id: 1, holdReason: null }, { id: 2, holdReason: null }],
      [{ runEmployeeId: 1, status: "PUBLISHED" }, { runEmployeeId: 2, status: "PUBLISHED" }],
    );

    const result = await makePublisher(db).publish(ORG_ID, RUN_ID, ACTOR, undefined, [2]);

    expect(inserted.map((row) => row.runEmployeeId)).toEqual([2]);
    expect(result.runStatus).toBe("PAYSLIPS_PUBLISHED");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a bulk publish on an already-published run", async () => {
    const { db } = makePublisherDb("PAYSLIPS_PUBLISHED", [], []);

    await expect(makePublisher(db).publish(ORG_ID, RUN_ID, ACTOR)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("PublishingService.releaseHold — cross-tenant isolation and release", () => {
  function makeService(run: { id: number; status: string } | null, updated: { id: number }[] = [{ id: 2 }]) {
    const sets: Record<string, unknown>[] = [];
    const db = {
      query: { payrollRuns: { findFirst: jest.fn().mockResolvedValue(run) } },
      update: () => ({
        set: (values: Record<string, unknown>) => {
          sets.push(values);
          return { where: () => ({ returning: () => Promise.resolve(updated) }) };
        },
      }),
    } as unknown as Db;
    const publisher = {
      publish: jest.fn().mockResolvedValue({ published: 1, total: 1, heldCount: 0, runStatus: "PAYSLIPS_PUBLISHED" }),
    };
    const audit = { log: jest.fn() };
    const svc = new PublishingService(
      db,
      audit as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      publisher as never,
      {} as never,
    );
    return { svc, sets, publisher, audit };
  }

  it("404s another org's run (cross-tenant) without touching any row", async () => {
    const { svc, sets } = makeService(null);

    await expect(svc.releaseHold(OTHER_ORG, RUN_ID, 2, ACTOR)).rejects.toThrow(NotFoundException);
    expect(sets).toHaveLength(0);
  });

  it("404s an employee that is not in this org's run", async () => {
    const { svc, publisher } = makeService({ id: RUN_ID, status: "PAID" }, []);

    await expect(svc.releaseHold(ORG_ID, RUN_ID, 999, ACTOR)).rejects.toThrow(NotFoundException);
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("clears the hold and publishes that one payslip once the run is in the payslip stage", async () => {
    const { svc, sets, publisher, audit } = makeService({ id: RUN_ID, status: "PAYSLIPS_PUBLISHED" });

    const result = await svc.releaseHold(ORG_ID, RUN_ID, 2, ACTOR);

    expect(sets).toEqual([{ holdReason: null }]);
    expect(publisher.publish).toHaveBeenCalledWith(ORG_ID, RUN_ID, ACTOR, undefined, [2]);
    expect(result.published).toBe(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.employee_unheld" }));
  });

  it("only clears the hold before the payslip stage", async () => {
    const { svc, sets, publisher } = makeService({ id: RUN_ID, status: "LOCKED" });

    const result = await svc.releaseHold(ORG_ID, RUN_ID, 2, ACTOR);

    expect(sets).toEqual([{ holdReason: null }]);
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(result).toEqual({ published: 0, total: 0, heldCount: 0, runStatus: "LOCKED" });
  });

  it("refuses on a CLOSED run", async () => {
    const { svc, sets } = makeService({ id: RUN_ID, status: "CLOSED" });

    await expect(svc.releaseHold(ORG_ID, RUN_ID, 2, ACTOR)).rejects.toBeInstanceOf(ConflictException);
    expect(sets).toHaveLength(0);
  });
});
