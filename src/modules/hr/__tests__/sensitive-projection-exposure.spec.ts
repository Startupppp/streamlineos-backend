process.env.APP_URL ??= "http://localhost:1000";

import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { readFileSync } from "fs";
import { join } from "path";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { HrSensitiveService } from "../core/hr-sensitive.service";
import { HrAuditService } from "../core/hr-audit.service";
import { HrBenefitsEnrollmentService } from "../benefits/hr-benefits-enrollment.service";
import { HrPolicyEvaluationService } from "../policies/hr-policy-evaluation.service";
import { HrBenefitsPlansService } from "../benefits/hr-benefits-plans.service";
import { CompPlanningService } from "../enterprise-comp/comp-planning.service";
import { HrEffectiveChangesService } from "../core/hr-effective-changes.service";
import { HrRecruitmentReportsService } from "../interviews/hr-recruitment-reports.service";
import { HrSalaryStructuresService } from "../config/hr-salary-structures.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";

const SVC_DIR = join(__dirname, "..");

function assertProjection(
  val: unknown,
): asserts val is Record<string, unknown> {
  expect(val !== null && typeof val === "object").toBe(true);
}

function makeChain(result: unknown[] = []) {
  const chain: Record<string, unknown> = {};
  const thenFn = (
    resolve: (v: unknown[]) => void,
    _reject?: (r: unknown) => void,
  ) => resolve(result);
  chain["then"] = thenFn;
  chain["from"] = jest.fn().mockReturnValue(chain);
  chain["where"] = jest.fn().mockReturnValue(chain);
  chain["orderBy"] = jest.fn().mockReturnValue(chain);
  chain["innerJoin"] = jest.fn().mockReturnValue(chain);
  chain["limit"] = jest.fn().mockReturnValue(chain);
  chain["offset"] = jest.fn().mockReturnValue(chain);
  chain["catch"] = jest.fn().mockReturnValue(chain);
  return chain;
}

describe("sensitive-projection-exposure", () => {
  describe("structural regression — no bare .select() on sensitive tables", () => {
    it("hr-sensitive.service.ts: hrEmployeeSensitiveFields select is explicit", () => {
      const src = readFileSync(
        join(SVC_DIR, "core/hr-sensitive.service.ts"),
        "utf8",
      );
      expect(src).not.toMatch(
        /\.select\(\s*\)\s*\n?\s*\.from\(hrEmployeeSensitiveFields/,
      );
    });

    it("hr-benefits-enrollment.service.ts: all hrDependents selects are explicit (4 sites)", () => {
      const src = readFileSync(
        join(SVC_DIR, "benefits/hr-benefits-enrollment.service.ts"),
        "utf8",
      );
      expect(src).not.toMatch(
        /\.select\(\s*\)\s*\n?\s*\.from\(hrDependents/,
      );
    });

    it("comp-planning.service.ts: hrCompRecommendations selects are explicit (2 sites)", () => {
      const src = readFileSync(
        join(SVC_DIR, "enterprise-comp/comp-planning.service.ts"),
        "utf8",
      );
      expect(src).not.toMatch(
        /\.select\(\s*\)\s*\n?\s*\.from\(hrCompRecommendations/,
      );
    });

    it("payroll-inputs-build.service.ts: overtimeRequests select is explicit", () => {
      const src = readFileSync(
        join(SVC_DIR, "payroll-inputs/payroll-inputs-build.service.ts"),
        "utf8",
      );
      expect(src).not.toMatch(
        /\.select\(\s*\)\s*\n?\s*\.from\(overtimeRequests/,
      );
    });

    it("payroll-inputs-build.service.ts: reimbursements select is explicit", () => {
      const src = readFileSync(
        join(SVC_DIR, "payroll-inputs/payroll-inputs-build.service.ts"),
        "utf8",
      );
      expect(src).not.toMatch(
        /\.select\(\s*\)\s*\n?\s*\.from\(reimbursements/,
      );
    });

    it("payroll-inputs-build.service.ts: salaryLoans select is explicit", () => {
      const src = readFileSync(
        join(SVC_DIR, "payroll-inputs/payroll-inputs-build.service.ts"),
        "utf8",
      );
      expect(src).not.toMatch(
        /\.select\(\s*\)\s*\n?\s*\.from\(salaryLoans/,
      );
    });

    it("payroll-inputs-build.service.ts: employeeSalaryProfiles select is explicit", () => {
      const src = readFileSync(
        join(SVC_DIR, "payroll-inputs/payroll-inputs-build.service.ts"),
        "utf8",
      );
      expect(src).not.toMatch(
        /\.select\(\s*\)\s*\n?\s*\.from\(employeeSalaryProfiles/,
      );
    });

    it("hr-recruitment-reports.service.ts: candidateOffers select is explicit", () => {
      const src = readFileSync(
        join(SVC_DIR, "interviews/hr-recruitment-reports.service.ts"),
        "utf8",
      );
      expect(src).not.toMatch(
        /\.select\(\s*\)\s*\n?\s*\.from\(candidateOffers/,
      );
    });
  });

  describe("behavioural — projection key allowlists", () => {
    describe("HrSensitiveService.get", () => {
      const SENSITIVE_ALLOWLIST = [
        "id",
        "orgId",
        "employmentId",
        "salaryAmountCents",
        "salaryCurrency",
        "salaryFrequency",
        "bankDetails",
        "taxId",
        "panNumber",
        "nationalId",
        "passportNumber",
        "passportExpiry",
        "visaType",
        "visaExpiry",
        "medicalNotes",
        "bloodGroup",
        "disciplinaryRecords",
        "grievanceRecords",
        "bgvStatus",
        "bgvCompletedAt",
        "createdAt",
        "updatedAt",
      ].sort();

      it("queries exactly the sensitive-field allowlist", async () => {
        const capturedProjs: (Record<string, unknown> | undefined)[] = [];

        const mockDb = {
          select: jest.fn().mockImplementation(
            (proj: Record<string, unknown> | undefined) => {
              capturedProjs.push(proj);
              const callIdx = capturedProjs.length - 1;
              return callIdx === 0
                ? makeChain([{ id: 1 }])
                : makeChain([]);
            },
          ),
        };

        const auditMock = { log: jest.fn().mockResolvedValue(undefined) };

        const module = await Test.createTestingModule({
          providers: [
            HrSensitiveService,
            { provide: DRIZZLE, useValue: mockDb },
            { provide: HrAuditService, useValue: auditMock },
          ],
        }).compile();

        const service = module.get(HrSensitiveService);
        const result = await service.get("org1", 1, "actor1");
        expect(result).toBeNull();

        expect(capturedProjs.length).toBeGreaterThanOrEqual(2);
        const sensitiveProj = capturedProjs[1];
        assertProjection(sensitiveProj);
        expect(Object.keys(sensitiveProj).sort()).toEqual(SENSITIVE_ALLOWLIST);
      });
    });

    describe("HrBenefitsEnrollmentService.listDependents", () => {
      const DEPENDENT_ALLOWLIST = [
        "id",
        "orgId",
        "userId",
        "name",
        "relationship",
        "dateOfBirth",
        "isCovered",
        "createdAt",
      ].sort();

      it("projects exactly the dependent allowlist — no dateOfBirth leak via extra columns", async () => {
        let capturedProj: Record<string, unknown> | undefined;

        const mockDb = {
          select: jest.fn().mockImplementation(
            (proj: Record<string, unknown> | undefined) => {
              capturedProj = proj;
              return makeChain([]);
            },
          ),
        };

        const module = await Test.createTestingModule({
          providers: [
            HrBenefitsEnrollmentService,
            { provide: DRIZZLE, useValue: mockDb },
            { provide: HrPolicyEvaluationService, useValue: {} },
            { provide: HrBenefitsPlansService, useValue: {} },
          ],
        }).compile();

        const service = module.get(HrBenefitsEnrollmentService);
        await service.listDependents("org1", "user1", 1);

        assertProjection(capturedProj);
        expect(Object.keys(capturedProj).sort()).toEqual(DEPENDENT_ALLOWLIST);
        expect(Object.keys(capturedProj)).not.toContain("updatedAt");
      });
    });

    describe("HrBenefitsEnrollmentService.updateDependent BOLA check", () => {
      it("BOLA check selects only id from hrDependents", async () => {
        let capturedProj: Record<string, unknown> | undefined;

        const mockDb = {
          select: jest.fn().mockImplementation(
            (proj: Record<string, unknown> | undefined) => {
              capturedProj = proj;
              return makeChain([]);
            },
          ),
          update: jest.fn().mockReturnValue({
            set: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                returning: jest.fn().mockResolvedValue([{ id: 1 }]),
              }),
            }),
          }),
        };

        const module = await Test.createTestingModule({
          providers: [
            HrBenefitsEnrollmentService,
            { provide: DRIZZLE, useValue: mockDb },
            { provide: HrPolicyEvaluationService, useValue: {} },
            { provide: HrBenefitsPlansService, useValue: {} },
          ],
        }).compile();

        const service = module.get(HrBenefitsEnrollmentService);
        await expect(
          service.updateDependent("org1", "user1", 1, 1, { name: "Test" }),
        ).rejects.toThrow(NotFoundException);

        assertProjection(capturedProj);
        expect(Object.keys(capturedProj).sort()).toEqual(["id"]);
        expect(Object.keys(capturedProj)).not.toContain("dateOfBirth");
      });
    });

    describe("CompPlanningService.listRecommendations", () => {
      const REC_ALLOWLIST = [
        "id",
        "cycleId",
        "userId",
        "currentSalaryCents",
        "recommendedIncreaseCents",
        "recommendedPct",
        "rating",
        "managerNote",
        "hrCalibratedCents",
        "status",
        "createdAt",
      ].sort();

      it("projects exactly the recommendation allowlist — no orgId/submittedBy/approvedBy leak", async () => {
        const capturedProjs: (Record<string, unknown> | undefined)[] = [];

        const mockDb = {
          select: jest.fn().mockImplementation(
            (proj: Record<string, unknown> | undefined) => {
              capturedProjs.push(proj);
              return makeChain([]);
            },
          ),
        };

        const auditMock = { log: jest.fn().mockResolvedValue(undefined) };

        const module = await Test.createTestingModule({
          providers: [
            CompPlanningService,
            { provide: DRIZZLE, useValue: mockDb },
            { provide: HrAuditService, useValue: auditMock },
            { provide: HrEffectiveChangesService, useValue: {} },
          ],
        }).compile();

        const service = module.get(CompPlanningService);
        await service.listRecommendations("org1", { limit: 10 });

        expect(capturedProjs.length).toBeGreaterThanOrEqual(1);
        const recProj = capturedProjs[0];
        assertProjection(recProj);
        expect(Object.keys(recProj).sort()).toEqual(REC_ALLOWLIST);
        expect(Object.keys(recProj)).not.toContain("orgId");
        expect(Object.keys(recProj)).not.toContain("submittedBy");
        expect(Object.keys(recProj)).not.toContain("approvedBy");
        expect(Object.keys(recProj)).not.toContain("calibratedBy");
      });
    });

    describe("CompPlanningService.approveRecommendation", () => {
      const APPROVE_BOLA_ALLOWLIST = [
        "id",
        "cycleId",
        "currentSalaryCents",
        "recommendedIncreaseCents",
        "hrCalibratedCents",
      ].sort();

      it("pre-approval select projects only the fields needed for the approval logic", async () => {
        let capturedProj: Record<string, unknown> | undefined;

        const mockDb = {
          select: jest.fn().mockImplementation(
            (proj: Record<string, unknown> | undefined) => {
              capturedProj = proj;
              return makeChain([]);
            },
          ),
        };

        const auditMock = { log: jest.fn().mockResolvedValue(undefined) };

        const module = await Test.createTestingModule({
          providers: [
            CompPlanningService,
            { provide: DRIZZLE, useValue: mockDb },
            { provide: HrAuditService, useValue: auditMock },
            { provide: HrEffectiveChangesService, useValue: {} },
          ],
        }).compile();

        const service = module.get(CompPlanningService);
        await expect(
          service.approveRecommendation("org1", 1, "actor1", {
            employmentId: 1,
            effectiveFrom: "2026-01-01",
          }),
        ).rejects.toThrow(NotFoundException);

        assertProjection(capturedProj);
        expect(Object.keys(capturedProj).sort()).toEqual(APPROVE_BOLA_ALLOWLIST);
        expect(Object.keys(capturedProj)).not.toContain("managerNote");
        expect(Object.keys(capturedProj)).not.toContain("orgId");
      });
    });

    describe("HrRecruitmentReportsService.generateReport offers", () => {
      const OFFER_ALLOWLIST = [
        "id",
        "offerStatus",
        "offeredSalary",
        "offeredDesignation",
        "joiningDate",
        "validUntil",
        "sentAt",
        "respondedAt",
        "createdAt",
      ].sort();

      it("projects exactly OFFER_FIELDS — no acceptanceToken or offeredBy leak", async () => {
        let capturedProj: Record<string, unknown> | undefined;

        const mockDb = {
          select: jest.fn().mockImplementation(
            (proj: Record<string, unknown> | undefined) => {
              capturedProj = proj;
              return makeChain([]);
            },
          ),
        };

        const cacheMock = {
          cached: jest.fn().mockResolvedValue({}),
        };

        const module = await Test.createTestingModule({
          providers: [
            HrRecruitmentReportsService,
            { provide: DRIZZLE, useValue: mockDb },
            { provide: CacheService, useValue: cacheMock },
          ],
        }).compile();

        const service = module.get(HrRecruitmentReportsService);
        const result = await service.generateReport("org1", {
          entity: "offers",
          fields: [],
          filters: {},
        });

        expect(result.rows).toEqual([]);
        assertProjection(capturedProj);
        expect(Object.keys(capturedProj).sort()).toEqual(OFFER_ALLOWLIST);
        expect(Object.keys(capturedProj)).not.toContain("acceptanceToken");
        expect(Object.keys(capturedProj)).not.toContain("offeredBy");
        expect(Object.keys(capturedProj)).not.toContain("approvedBy");
        expect(Object.keys(capturedProj)).not.toContain("notes");
        expect(Object.keys(capturedProj)).not.toContain("viewedAt");
      });
    });

    describe("PayrollInputsBuildService.buildSnapshots — pay input projections", () => {
      const OT_ALLOWLIST = [
        "id",
        "userId",
        "date",
        "hours",
        "convertToCompOff",
      ].sort();

      const REIMB_ALLOWLIST = [
        "id",
        "userId",
        "category",
        "amount",
        "description",
        "payrollMonth",
        "approvedAt",
      ].sort();

      const LOAN_ALLOWLIST = [
        "id",
        "userId",
        "amount",
        "emiAmount",
        "totalEmis",
        "paidEmis",
        "reason",
      ].sort();

      const SALARY_PROFILE_ALLOWLIST = [
        "id",
        "userId",
        "annualCtc",
        "currency",
        "payFrequency",
        "effectiveFrom",
        "basicSalary",
        "allowances",
      ].sort();

      it("projects minimal columns for OT, reimbursements, loans and salary profiles", async () => {
        const { AttendanceSummaryService } = await import(
          "../time/attendance-summary.service"
        );
        const { LeaveLedgerService } = await import(
          "../time/leave-ledger.service"
        );
        const { HrBenefitsClaimsService } = await import(
          "../benefits/hr-benefits-claims.service"
        );
        const { PayrollInputsBuildService } = await import(
          "../payroll-inputs/payroll-inputs-build.service"
        );

        const capturedProjs: (Record<string, unknown> | undefined)[] = [];
        let selectCallIdx = 0;

        const memberRow = {
          userId: "u1",
          name: "Test User",
          firstName: null,
          lastName: null,
          email: "t@t.com",
        };

        const chains = [
          makeChain([memberRow]),
          makeChain([]),
          makeChain([]),
          makeChain([]),
          makeChain([]),
          makeChain([]),
        ];

        const mockDb = {
          select: jest.fn().mockImplementation(
            (proj: Record<string, unknown> | undefined) => {
              capturedProjs.push(proj);
              const chain = chains[selectCallIdx] ?? makeChain([]);
              selectCallIdx++;
              return chain;
            },
          ),
          transaction: jest
            .fn()
            .mockImplementation(
              async (
                cb: (tx: Record<string, jest.Mock>) => Promise<unknown>,
              ) => {
                const tx: Record<string, jest.Mock> = {
                  delete: jest.fn().mockReturnValue({
                    where: jest.fn().mockResolvedValue(undefined),
                  }),
                  insert: jest.fn().mockReturnValue({
                    values: jest.fn().mockResolvedValue(undefined),
                  }),
                };
                return cb(tx);
              },
            ),
        };

        const attendanceMock = {
          buildAttendanceSummary: jest
            .fn()
            .mockResolvedValue({ data: [], total: 0 }),
        };

        const leaveMock = {
          buildLeaveSummary: jest.fn().mockResolvedValue([]),
        };

        const benefitsMock = {
          getPayrollPayableClaims: jest.fn().mockResolvedValue([]),
          getDueLoanRepayments: jest.fn().mockResolvedValue([]),
        };

        const module = await Test.createTestingModule({
          providers: [
            PayrollInputsBuildService,
            { provide: DRIZZLE, useValue: mockDb },
            { provide: AttendanceSummaryService, useValue: attendanceMock },
            { provide: LeaveLedgerService, useValue: leaveMock },
            { provide: HrBenefitsClaimsService, useValue: benefitsMock },
          ],
        }).compile();

        const service = module.get(PayrollInputsBuildService);
        const period = {
          id: 1,
          orgId: "org1",
          periodKey: "2026-01",
          status: "OPEN",
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        await service.buildSnapshots("org1", period as never);

        expect(capturedProjs.length).toBeGreaterThanOrEqual(5);

        const otProj = capturedProjs[1];
        assertProjection(otProj);
        expect(Object.keys(otProj).sort()).toEqual(OT_ALLOWLIST);
        expect(Object.keys(otProj)).not.toContain("reason");
        expect(Object.keys(otProj)).not.toContain("approverId");

        const reimbProj = capturedProjs[2];
        assertProjection(reimbProj);
        expect(Object.keys(reimbProj).sort()).toEqual(REIMB_ALLOWLIST);
        expect(Object.keys(reimbProj)).not.toContain("receiptUrl");
        expect(Object.keys(reimbProj)).not.toContain("rejectionReason");

        const loanProj = capturedProjs[3];
        assertProjection(loanProj);
        expect(Object.keys(loanProj).sort()).toEqual(LOAN_ALLOWLIST);
        expect(Object.keys(loanProj)).not.toContain("approvedBy");
        expect(Object.keys(loanProj)).not.toContain("disbursedAt");

        const salaryProfProj = capturedProjs[4];
        assertProjection(salaryProfProj);
        expect(Object.keys(salaryProfProj).sort()).toEqual(
          SALARY_PROFILE_ALLOWLIST,
        );
        expect(Object.keys(salaryProfProj)).not.toContain("taxRegime");
        expect(Object.keys(salaryProfProj)).not.toContain("createdBy");
        expect(Object.keys(salaryProfProj)).not.toContain("deductions");
      });
    });

    describe("HrSalaryStructuresService.list — compensation key-set", () => {
      const SALARY_LIST_ALLOWLIST = [
        "id",
        "orgId",
        "userId",
        "annualCtc",
        "basicSalary",
        "hraPercentage",
        "allowances",
        "deductions",
        "status",
        "effectiveFrom",
        "effectiveTo",
        "currency",
        "payFrequency",
        "createdAt",
        "updatedAt",
      ].sort();

      it("projects exactly the salary list allowlist — no taxRegime, createdBy, workerId, costCenter, fxSource leak", async () => {
        let capturedColumns: Record<string, unknown> | undefined;

        const mockDb = {
          query: {
            employeeSalaryProfiles: {
              findMany: jest.fn().mockImplementation(
                (opts: { columns?: Record<string, unknown> }) => {
                  capturedColumns = opts.columns;
                  return Promise.resolve([]);
                },
              ),
            },
          },
        };

        const auditMock = { log: jest.fn() };
        const cacheMock = { cached: jest.fn(), del: jest.fn() };

        const module = await Test.createTestingModule({
          providers: [
            HrSalaryStructuresService,
            { provide: DRIZZLE, useValue: mockDb },
            { provide: AuditService, useValue: auditMock },
            { provide: CacheService, useValue: cacheMock },
          ],
        }).compile();

        const service = module.get(HrSalaryStructuresService);
        await service.list("org1", undefined, "user1", false);

        assertProjection(capturedColumns);
        expect(Object.keys(capturedColumns).sort()).toEqual(SALARY_LIST_ALLOWLIST);
        expect(Object.keys(capturedColumns)).not.toContain("taxRegime");
        expect(Object.keys(capturedColumns)).not.toContain("createdBy");
        expect(Object.keys(capturedColumns)).not.toContain("workerId");
        expect(Object.keys(capturedColumns)).not.toContain("workerType");
        expect(Object.keys(capturedColumns)).not.toContain("costCenter");
        expect(Object.keys(capturedColumns)).not.toContain("fxSource");
        expect(Object.keys(capturedColumns)).not.toContain("payoutCurrency");
        expect(Object.keys(capturedColumns)).not.toContain("policyVersionId");
      });
    });
  });
});
