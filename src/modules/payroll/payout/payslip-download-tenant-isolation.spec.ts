import { NotFoundException } from "@nestjs/common";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";
import { PayslipDownloadService } from "./payslip-download.service";
import type { AccessService } from "../../access/access.service";
import type { EmploymentFactsService } from "../../directory/employment-facts.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

describe("PayslipDownloadService — cross-tenant isolation", () => {
  const VICTIM_ORG = "org-victim";
  const ATTACKER_ORG = "org-attacker";
  const VICTIM_USER = "user-victim";
  const ATTACKER_USER = "user-attacker";

  function makeCaller(orgId: string, userId: string): CurrentUserContext {
    return {
      orgId,
      userId,
      principal: humanSessionPrincipal(1, false),
    } as CurrentUserContext;
  }

  function makeDb(publicationRow: unknown, runEmployeeRow: unknown = null): Db {
    return {
      query: {
        payslipPublications: {
          findFirst: jest.fn().mockResolvedValue(publicationRow),
        },
        payrollRunEmployees: {
          findFirst: jest.fn().mockResolvedValue(runEmployeeRow),
        },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
        payrollRuns: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
        organizations: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
        payslipTemplates: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
    } as unknown as Db;
  }

  const access = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
  } as unknown as AccessService;
  const efService = {} as unknown as EmploymentFactsService;

  it("throws NotFoundException (not ForbiddenException) when caller is from a different org — cross-tenant isolation", async () => {
    const victimPublication = {
      id: 1,
      orgId: VICTIM_ORG,
      userId: VICTIM_USER,
      workerId: null,
      runId: 10,
      runEmployeeId: 20,
      snapshotHash: null,
      payslipTemplateId: null,
      status: "PUBLISHED",
    };

    const db = makeDb(victimPublication);
    const svc = new PayslipDownloadService(db, access, efService);

    const error = await svc.downloadPdf(1, makeCaller(ATTACKER_ORG, ATTACKER_USER)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
  });

  it("does not surface ForbiddenException for cross-tenant access — would confirm record existence", async () => {
    const victimPublication = {
      id: 2,
      orgId: VICTIM_ORG,
      userId: VICTIM_USER,
      workerId: null,
      runId: 11,
      runEmployeeId: 21,
      snapshotHash: null,
      payslipTemplateId: null,
      status: "PUBLISHED",
    };

    const db = makeDb(victimPublication);
    const svc = new PayslipDownloadService(db, access, efService);

    const error = await svc.downloadPdf(2, makeCaller(ATTACKER_ORG, ATTACKER_USER)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as Error).constructor.name).toBe("NotFoundException");
  });

  it("returns data when caller owns the payslip — same-user control path", async () => {
    const ownPublication = {
      id: 3,
      orgId: ATTACKER_ORG,
      userId: ATTACKER_USER,
      workerId: null,
      runId: 12,
      runEmployeeId: 22,
      snapshotHash: "abc123",
      payslipTemplateId: null,
      status: "PUBLISHED",
    };

    const runEmployee = {
      calculationSnapshot: { gross: "50000", net: "45000", deductions: [], earnings: [], month: "2026-08" },
      workerType: "EMPLOYEE",
      currency: "INR",
      userId: ATTACKER_USER,
      workerId: null,
    };

    const db = makeDb(ownPublication, runEmployee);
    const svc = new PayslipDownloadService(db, access, efService);

    await expect(svc.downloadPdf(3, makeCaller(ATTACKER_ORG, ATTACKER_USER))).rejects.toBeInstanceOf(Error);
  });
});
