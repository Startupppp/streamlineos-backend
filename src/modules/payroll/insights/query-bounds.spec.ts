import { ConflictException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import type { Db } from "../../../db/drizzle.module";
import { AccountingMappingsService } from "./accounting-mappings.service";
import { TaxWindowsService } from "./tax-windows.service";

describe("Payroll insights query bounds", () => {
  it("accounting mappings probes one overflow row and fails instead of truncating", async () => {
    const limit = jest.fn().mockResolvedValue(Array.from({ length: 501 }, (_, id) => ({ id })));
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({ limit }),
          }),
        }),
      }),
    } as unknown as Db;

    await expect(new AccountingMappingsService(db).list("org-1"))
      .rejects.toBeInstanceOf(ConflictException);
    expect(limit).toHaveBeenCalledWith(501);
  });

  it("tax-window history probes overflow and unique create lookup reads one row", async () => {
    const historyLimit = jest.fn().mockResolvedValue(Array.from({ length: 101 }, (_, id) => ({ id })));
    const uniqueLimit = jest.fn().mockResolvedValue([]);
    const select = jest.fn()
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({ limit: historyLimit }),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: uniqueLimit }),
        }),
      });
    const db = {
      select,
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]) }),
      }),
    } as unknown as Db;
    const service = new TaxWindowsService(db, {} as never);

    await expect(service.list("org-1")).rejects.toBeInstanceOf(ConflictException);
    await service.create("org-1", {
      financialYear: "2026-27",
      opensAt: "2026-04-01T00:00:00.000Z",
      closesAt: "2027-03-31T00:00:00.000Z",
    });

    expect(historyLimit).toHaveBeenCalledWith(101);
    expect(uniqueLimit).toHaveBeenCalledWith(1);
  });

  it("manager inbox fetches at most one latest payslip and declaration per bounded report", () => {
    const source = readFileSync(require.resolve("./manager-inbox.service"), "utf8");
    expect(source).toContain(".limit(directReportIds.length)");
    expect(source).toContain(".selectDistinctOn([payslipPublications.userId]");
    expect(source).toContain(".selectDistinctOn([taxDeclarations.userId]");
    expect(source).toContain(".limit(reportIds.length)");
    expect(source).toContain("asc(payslipPublications.userId)");
    expect(source).toContain("asc(taxDeclarations.userId)");
  });

  it("the tax declaration CSV export probes past its cap instead of silently truncating", () => {
    const source = readFileSync(require.resolve("./tax-admin.service"), "utf8");
    expect(source).toContain(".limit(PAYROLL_READ_CAP + 1)");
    expect(source).toContain('requirePayrollReadWithinCap(rows, "export tax declarations")');
    expect(source).not.toContain(".limit(100)");
  });

  it("bounds payroll proof, approval, command-center, and team-reward whole-set reads", () => {
    const tax = readFileSync(require.resolve("../hr-payroll/tax.service"), "utf8");
    expect(tax).toContain(".limit(501)");
    expect(tax).toContain("Investment proofs exceed the supported 500-row declaration bound");

    const approvalActions = readFileSync(require.resolve("../payout/approval-actions.service"), "utf8");
    expect(approvalActions.match(/\.limit\(21\)/g)).toHaveLength(2);
    expect(approvalActions.match(/exceeds the supported 20-stage bound/g)).toHaveLength(2);

    const approvals = readFileSync(require.resolve("../payout/approvals.service"), "utf8");
    expect(approvals).toContain("select({ total: count() })");
    expect(approvals).toContain(".limit(21)");
    expect(approvals).toContain("if (rows.length > 20)");

    const commandCenter = readFileSync(require.resolve("../runs/command-center.service"), "utf8");
    expect(commandCenter).toContain(".limit(101)");
    expect(commandCenter).toContain(".limit(21)");
    expect(commandCenter).toContain("if (upcomingCalendarEvents.length > 100)");
    expect(commandCenter).toContain("if (pendingApprovals.length > 20)");

    const teamRewards = readFileSync(require.resolve("./team-rewards.service"), "utf8");
    expect(teamRewards).toContain(".limit(reportIds.length + 1)");
    expect(teamRewards).toContain(".limit(reportIds.length * MAX_BENEFIT_ENROLLMENTS_PER_REPORT + 1)");
    expect(teamRewards).toContain(".limit(reportIds.length * MAX_EQUITY_GRANTS_PER_REPORT + 1)");
    expect(teamRewards).toContain(".limit(MAX_ORG_PAY_COMPRESSION_PROFILES + 1)");
    expect(teamRewards).toContain(".limit(reportIds.length)");
  });

  it("calendar month generation derives the lookup set from the always-defined event definitions", () => {
    const source = readFileSync(require.resolve("./calendar.service"), "utf8");
    expect(source).toContain("inArray(payrollCalendarEvents.type, eventDefs.map((event) => event.type))");
    expect(source).not.toContain("events.map((event) => event.type)");
  });
});
