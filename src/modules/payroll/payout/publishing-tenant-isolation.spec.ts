import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { PublishingService } from "./publishing.service";

describe("PublishingService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const audit = { log: jest.fn() } as never;
  const storage = { upload: jest.fn() } as never;
  const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as never;
  const notifications = { notifyPayslipPublished: jest.fn().mockResolvedValue(undefined) } as never;
  const notifDispatch = { dispatch: jest.fn().mockResolvedValue(undefined) } as never;
  const efService = { getWorkerForUser: jest.fn().mockResolvedValue(null), getDirectReportUserIds: jest.fn().mockResolvedValue([]) } as never;

  it("throws NotFoundException for listPublications when run belongs to a different org (cross-tenant isolation)", async () => {
    const db = {
      query: {
        payrollRuns: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    } as unknown as Db;
    const svc = new PublishingService(db, audit, storage, access, notifications, notifDispatch, efService, {} as never, {} as never);
    await expect(svc.listPublications(ATTACKER_ORG, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns publications for the owning org (same-tenant control)", async () => {
    const run = { id: 1 };
    const pubs = [{ id: 1, runId: 1, orgId: OWNER_ORG, status: "PUBLISHED" }];
    const db = {
      query: {
        payrollRuns: { findFirst: jest.fn().mockResolvedValue(run) },
        payslipPublications: { findMany: jest.fn().mockResolvedValue(pubs) },
      },
    } as unknown as Db;
    const svc = new PublishingService(db, audit, storage, access, notifications, notifDispatch, efService, {} as never, {} as never);
    const result = await svc.listPublications(OWNER_ORG, 1);
    expect(result.items).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });
});
