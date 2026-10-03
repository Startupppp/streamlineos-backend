import { NotFoundException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../db/drizzle.module";
import { Form16DocumentsService } from "./filings/form16-documents.service";
import { FnfSuggestionService } from "./hr-payroll/fnf-suggestion.service";
import { SalaryPreviewService } from "./setup/salary-preview.service";
import type { EmploymentFactsService } from "../directory/employment-facts.service";
import type { RunDataLoaderService } from "./runs/run-data-loader.service";
import type { StorageService } from "../storage/storage.service";
import type { AvScanner } from "../../common/security/av-scan";
import type { AuditService } from "../../common/audit/audit.service";

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const dialect = new PgDialect();

function params(where: unknown) {
  return dialect.sqlToQuery(where as SQL).params;
}

function readChain(rows: unknown[]) {
  const wheres: unknown[] = [];
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
  };
  for (const method of ["from", "leftJoin", "innerJoin", "orderBy", "limit"]) chain[method] = jest.fn(() => chain);
  chain["where"] = jest.fn((w: unknown) => {
    wheres.push(w);
    return chain;
  });
  return { chain, wheres };
}

describe("Form16DocumentsService — cross-tenant isolation", () => {
  function build(rows: unknown[]) {
    const read = readChain(rows);
    const update = jest.fn();
    const db = { select: jest.fn(() => read.chain), update } as unknown as Db;
    const storage = { getFileStream: jest.fn() } as unknown as StorageService;
    const svc = new Form16DocumentsService(db, storage, {} as AvScanner, { log: jest.fn() } as unknown as AuditService);
    return { svc, read, update, storage };
  }

  it("download of another org's Form 16 is a 404 and reads only the caller's org", async () => {
    const { svc, read, storage } = build([]);
    await expect(svc.download(ATTACKER_ORG, "2025-26", 7)).rejects.toBeInstanceOf(NotFoundException);
    expect(params(read.wheres[0])).toContain(ATTACKER_ORG);
    expect(params(read.wheres[0])).not.toContain(OWNER_ORG);
    expect(storage.getFileStream).not.toHaveBeenCalled();
  });

  it("release of a member from a different org is a 404 and never writes", async () => {
    const { svc, read, update } = build([]);
    const actor = { orgId: ATTACKER_ORG, userId: "u-attacker", membershipId: 1 };
    await expect(svc.release(actor, "2025-26", 7)).rejects.toThrow("Employee not found in your organization");
    expect(params(read.wheres[0])).toContain(ATTACKER_ORG);
    expect(update).not.toHaveBeenCalled();
  });

  it("downloadOwn cannot reach another org's released document", async () => {
    const { svc, read, storage } = build([]);
    await expect(svc.downloadOwn(ATTACKER_ORG, 7, "2025-26")).rejects.toBeInstanceOf(NotFoundException);
    expect(params(read.wheres[0])).toContain(ATTACKER_ORG);
    expect(storage.getFileStream).not.toHaveBeenCalled();
  });
});

describe("FnfSuggestionService — cross-tenant isolation", () => {
  it("suggesting F&F for a user in a different org is a 404 before any read of their facts", async () => {
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const db = { query: { organizationMembers: { findFirst } }, select: jest.fn() } as unknown as Db;
    const facts = { getFacts: jest.fn() } as unknown as EmploymentFactsService;
    const svc = new FnfSuggestionService(db, facts);
    await expect(svc.suggest(ATTACKER_ORG, { userId: "victim", lastWorkingDay: "2026-03-31" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(params(findFirst.mock.calls[0][0].where)).toEqual(expect.arrayContaining(["victim", ATTACKER_ORG]));
    expect(facts.getFacts).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("scopes the leave balance and its encashable-policy probe to the caller's org", async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 3 });
    const basic = readChain([]);
    const leave = readChain([{ days: "4" }]);
    const select = jest.fn().mockReturnValueOnce(basic.chain).mockReturnValueOnce(leave.chain);
    const db = { query: { organizationMembers: { findFirst } }, select } as unknown as Db;
    const facts = { getFacts: jest.fn().mockResolvedValue({ joiningDate: null }) } as unknown as EmploymentFactsService;
    const svc = new FnfSuggestionService(db, facts);
    const result = await svc.suggest(OWNER_ORG, { userId: "u1", lastWorkingDay: "2026-03-31" });
    expect(result.encashableLeaveDays).toBe("4.00");
    expect(facts.getFacts).toHaveBeenCalledWith(OWNER_ORG, "u1");
    const leaveQuery = dialect.sqlToQuery(leave.wheres[0] as SQL);
    expect(leaveQuery.params.filter((p) => p === OWNER_ORG)).toHaveLength(2);
    expect(leaveQuery.sql).toContain('"leave_policies"."org_id" = $');
    expect(params(basic.wheres[0])).toContain(OWNER_ORG);
  });
});

describe("SalaryPreviewService — cross-tenant isolation", () => {
  it("previewing with another org's component ids is a 404 and reads only the caller's org", async () => {
    const read = readChain([]);
    const db = { select: jest.fn(() => read.chain) } as unknown as Db;
    const runData = {
      loadPolicy: jest.fn().mockResolvedValue({ toggles: {}, config: {}, policyVersionId: 1 }),
      loadStatutoryStateCode: jest.fn(),
    } as unknown as RunDataLoaderService;
    const svc = new SalaryPreviewService(db, runData);
    await expect(svc.preview(ATTACKER_ORG, { annualCtc: "1200000", componentIds: [41, 42] })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(runData.loadPolicy).toHaveBeenCalledWith(ATTACKER_ORG, null);
    expect(params(read.wheres[0])).toContain(ATTACKER_ORG);
    expect(params(read.wheres[0])).not.toContain(OWNER_ORG);
    expect(runData.loadStatutoryStateCode).not.toHaveBeenCalled();
  });
});
