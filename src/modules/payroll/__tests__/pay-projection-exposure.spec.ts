import { readFileSync } from "fs";
import { join } from "path";
import { ProfilesService } from "../runs/profiles.service";
import { SalaryProfilesRepository } from "../runs/salary-profiles.repository";
import { FnfService } from "../hr-payroll/fnf.service";
import { SalaryStructureTemplatesService } from "../hr-payroll/salary-structure-templates.service";
import { EssService } from "../insights/ess.service";
import { salaryTemplateRowSchema } from "../hr-payroll/dto/hr-payroll-response.schemas";

const SERVICES_DIR = join(__dirname, "..");
const BARE_SELECT_RE = /\.select\s*\(\s*\)/;

function makeChain(result: unknown[]) {
  const promise = Promise.resolve(result);
  return {
    from: jest.fn().mockReturnThis(),
    // The worker-addressed reads resolve the worker through the person seam before they query, and
    // that resolution joins. Without these the chain throws before the projection under test runs.
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnValue(promise),
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  };
}

describe("pay-projection-exposure", () => {
  describe("structural: no bare .select() on sensitive tables", () => {
    it("profiles.service.ts has no bare .select()", () => {
      const src = readFileSync(
        join(SERVICES_DIR, "runs/profiles.service.ts"),
        "utf8",
      );
      expect(src).not.toMatch(BARE_SELECT_RE);
    });

    it("fnf.service.ts has no bare .select()", () => {
      const src = readFileSync(
        join(SERVICES_DIR, "hr-payroll/fnf.service.ts"),
        "utf8",
      );
      expect(src).not.toMatch(BARE_SELECT_RE);
    });

    it("salary-structure-templates.service.ts has no bare .select()", () => {
      const src = readFileSync(
        join(SERVICES_DIR, "hr-payroll/salary-structure-templates.service.ts"),
        "utf8",
      );
      expect(src).not.toMatch(BARE_SELECT_RE);
    });

    it("ess.service.ts has no bare .select()", () => {
      const src = readFileSync(
        join(SERVICES_DIR, "insights/ess.service.ts"),
        "utf8",
      );
      expect(src).not.toMatch(BARE_SELECT_RE);
    });
  });

  describe("behavioural: select projection keys match allowlist", () => {
    const PROFILE_KEYS = [
      "annualCtc",
      "costCenter",
      "currency",
      "effectiveFrom",
      "id",
      "payoutCurrency",
      "status",
      "taxRegime",
      "userId",
      "workerType",
      "workerId",
    ].sort();

    it("ProfilesService.listHistory projects exactly the profile allowlist", async () => {
      const row = {
        id: 1,
        userId: "u1",
        workerId: null,
        workerType: "EMPLOYEE",
        currency: "INR",
        payoutCurrency: null,
        annualCtc: "600000.00",
        taxRegime: "NEW",
        costCenter: null,
        status: "ACTIVE",
        effectiveFrom: "2024-01-01",
      };
      const chain = makeChain([row]);
      const db = {
        query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) } },
        select: jest.fn().mockReturnValue(chain),
      };
      const service = new ProfilesService(
        db as never,
        {} as never,
        new SalaryProfilesRepository(db as never),
      );

      const result = await service.listHistory("org-1", "u1");

      expect(Object.keys(db.select.mock.calls[0][0] as object).sort()).toEqual(
        PROFILE_KEYS,
      );
      expect(result).toHaveLength(1);
      const first = result[0] ?? {};
      expect(Object.keys(first).sort()).toEqual(PROFILE_KEYS);
      expect(first).not.toHaveProperty("basicSalary");
      expect(first).not.toHaveProperty("hraPercentage");
      expect(first).not.toHaveProperty("deductions");
      expect(first).not.toHaveProperty("allowances");
      expect(first).not.toHaveProperty("effectiveTo");
      expect(first).not.toHaveProperty("createdBy");
      expect(first).not.toHaveProperty("updatedAt");
    });

    it("ProfilesService.listHistoryByWorker projects exactly the profile allowlist", async () => {
      const row = {
        id: 2,
        userId: null,
        workerId: "w1",
        workerType: "CONTRACTOR",
        currency: "USD",
        payoutCurrency: null,
        annualCtc: "120000.00",
        taxRegime: null,
        costCenter: "ENG",
        status: "SUPERSEDED",
        effectiveFrom: "2023-01-01",
      };
      const chain = makeChain([row]);
      const db = { select: jest.fn().mockReturnValue(chain) };
      const service = new ProfilesService(
        db as never,
        {} as never,
        new SalaryProfilesRepository(db as never),
      );

      const result = await service.listHistoryByWorker("org-1", "w1");

      // The LAST select is the history query. `listHistoryByWorker` now resolves the worker under
      // the caller's organisation first — the guard that makes a cross-tenant `:workerId` answer
      // 404 instead of an empty 200 — so the projection under test is no longer call zero. The
      // claim this test makes is about the profile projection, not about call ordering.
      const historySelect = db.select.mock.calls.at(-1)?.[0] as object;
      expect(Object.keys(historySelect).sort()).toEqual(PROFILE_KEYS);
      const first = result[0] ?? {};
      expect(Object.keys(first).sort()).toEqual(PROFILE_KEYS);
      expect(first).not.toHaveProperty("basicSalary");
      expect(first).not.toHaveProperty("hraPercentage");
    });

    it("FnfService.updateFnf selects only status, approvedBy, notes from existing row", async () => {
      const existingRow = {
        status: "DRAFT",
        approvedBy: null,
        notes: null,
      };
      const updatedRow = {
        id: 1,
        orgId: "org-1",
        userId: "u1",
        resignationId: null,
        basicDues: "0.00",
        leaveEncashment: "0.00",
        gratuity: "0.00",
        bonusDue: "0.00",
        deductions: "0.00",
        loanRecovery: "0.00",
        netPayable: "5000.00",
        status: "PENDING_APPROVAL",
        approvedBy: null,
        notes: null,
        reimbursementsDue: "0.00",
        assetRecovery: "0.00",
        noticeRecovery: "0.00",
        otherDeductions: "0.00",
        statementPublishedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const selectChain = makeChain([existingRow]);
      const db = {
        select: jest.fn().mockReturnValue(selectChain),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([updatedRow]),
            }),
          }),
        }),
      };
      const service = new FnfService(db as never);

      const result = await service.updateFnf("org-1", "u1", 1, {
        status: "PENDING_APPROVAL",
      });

      expect(result.ok).toBe(true);
      const selectKeys = Object.keys(db.select.mock.calls[0][0] as object).sort();
      expect(selectKeys).toEqual(["approvedBy", "notes", "status"]);
    });

    it("SalaryStructureTemplatesService.list projects exactly its published wire contract", async () => {
      const row = {
        id: 1,
        orgId: "org-1",
        name: "Standard",
        basicSalary: "30000.00",
        hraPercent: "40.00",
        specialAllowance: "5000.00",
        medicalAllowance: "1250.00",
        travelAllowance: "1600.00",
        otherAllowances: null,
        pfDeductionPercent: "12.00",
        professionalTax: "200.00",
        effectiveFrom: "2024-01-01",
        effectiveTo: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const chain = makeChain([row]);
      const db = { select: jest.fn().mockReturnValue(chain) };
      const service = new SalaryStructureTemplatesService(db as never);

      const result = await service.list("org-1");

      const TEMPLATE_KEYS = Object.keys(salaryTemplateRowSchema.shape).sort();
      expect(TEMPLATE_KEYS).toContain("updatedAt");
      expect(Object.keys(db.select.mock.calls[0][0] as object).sort()).toEqual(
        TEMPLATE_KEYS,
      );
      const first = result.data[0] ?? {};
      expect(Object.keys(first).sort()).toEqual(TEMPLATE_KEYS);
      expect(first).not.toHaveProperty("deletedAt");
    });

    it("EssService.getOwnFnf projects allowlist without orgId/userId/approvedBy", async () => {
      const row = {
        id: 1,
        basicDues: "10000.00",
        leaveEncashment: "5000.00",
        gratuity: "0.00",
        bonusDue: "0.00",
        deductions: "0.00",
        loanRecovery: "0.00",
        netPayable: "15000.00",
        status: "APPROVED",
        notes: null,
        reimbursementsDue: "0.00",
        assetRecovery: "0.00",
        noticeRecovery: "0.00",
        otherDeductions: "0.00",
        statementPublishedAt: null,
        createdAt: new Date(),
      };
      const chain = makeChain([row]);
      const db = { select: jest.fn().mockReturnValue(chain) };
      const service = new EssService(
        db as never,
        {} as never,
      );

      const result = await service.getOwnFnf("org-1", "u1", null);

      const FNF_KEYS = [
        "assetRecovery",
        "basicDues",
        "bonusDue",
        "createdAt",
        "deductions",
        "gratuity",
        "id",
        "leaveEncashment",
        "loanRecovery",
        "netPayable",
        "notes",
        "noticeRecovery",
        "otherDeductions",
        "reimbursementsDue",
        "statementPublishedAt",
        "status",
      ];
      expect(Object.keys(db.select.mock.calls[0][0] as object).sort()).toEqual(
        FNF_KEYS,
      );
      expect(result).not.toBeNull();
      const r = result ?? {};
      expect(Object.keys(r).sort()).toEqual(FNF_KEYS);
      expect(r).not.toHaveProperty("orgId");
      expect(r).not.toHaveProperty("userId");
      expect(r).not.toHaveProperty("approvedBy");
      expect(r).not.toHaveProperty("updatedAt");
    });
  });
});
