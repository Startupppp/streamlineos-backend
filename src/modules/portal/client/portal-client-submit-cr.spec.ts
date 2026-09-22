import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { submitChangeRequestSchema } from "./dto/portal-client.schemas";
import { PortalClientService } from "./portal-client.service";
import type { Db } from "../../../db/drizzle.module";

describe("submitChangeRequestSchema — guest cannot supply internal assessment fields", () => {
  it("accepts a submission with title and description (positive control)", () => {
    const result = submitChangeRequestSchema.safeParse({ title: "Add feature", description: "Details here" });
    expect(result.success).toBe(true);
  });

  it("accepts a submission with title only, description being optional", () => {
    const result = submitChangeRequestSchema.safeParse({ title: "Add feature" });
    expect(result.success).toBe(true);
  });

  it("rejects impact field — title still accepted proving .strict() is what fires, not a parse failure", () => {
    const withImpact = submitChangeRequestSchema.safeParse({ title: "T", impact: "HIGH" });
    const withoutImpact = submitChangeRequestSchema.safeParse({ title: "T" });
    expect(withImpact.success).toBe(false);
    expect(withoutImpact.success).toBe(true);
  });

  it("rejects estimateMinutes field — title still accepted proving .strict() is what fires", () => {
    const withField = submitChangeRequestSchema.safeParse({ title: "T", estimateMinutes: 60 });
    const withoutField = submitChangeRequestSchema.safeParse({ title: "T" });
    expect(withField.success).toBe(false);
    expect(withoutField.success).toBe(true);
  });

  it("rejects budgetImpactCents field — title still accepted proving .strict() is what fires", () => {
    const withField = submitChangeRequestSchema.safeParse({ title: "T", budgetImpactCents: 50000 });
    const withoutField = submitChangeRequestSchema.safeParse({ title: "T" });
    expect(withField.success).toBe(false);
    expect(withoutField.success).toBe(true);
  });

  it("rejects timelineImpactDays field — title still accepted proving .strict() is what fires", () => {
    const withField = submitChangeRequestSchema.safeParse({ title: "T", timelineImpactDays: 5 });
    const withoutField = submitChangeRequestSchema.safeParse({ title: "T" });
    expect(withField.success).toBe(false);
    expect(withoutField.success).toBe(true);
  });
});

describe("PortalClientService.submitChangeRequest — internal fields not written to the database", () => {
  function makeDb(capturedInsertValues: Record<string, unknown>[]): Db {
    const txInsert = jest.fn().mockImplementation((values: Record<string, unknown>) => {
      capturedInsertValues.push(values);
      return {
        returning: jest.fn().mockResolvedValue([{
          id: 1,
          crNumber: 1,
          title: values.title,
          status: "submitted",
          createdAt: new Date(),
        }]),
      };
    });
    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue(
            Promise.resolve([{ maxNum: 0 }]),
          ),
        }),
      }),
      insert: jest.fn().mockReturnValue({ values: txInsert }),
    };
    const grantWhere = jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue([{
        organizationId: "org-1",
        portalMembershipId: "mem-1",
        projectId: 5,
        status: "ACTIVE",
        expiresAt: null,
        canSubmitChangeRequests: true,
        canViewMilestones: false,
        canViewTasks: false,
        canViewAttachments: false,
        canViewComments: false,
      }]),
    });
    return {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: grantWhere }) }),
      transaction: jest.fn().mockImplementation(async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as Db;
  }

  it("does not write impact, estimateMinutes, budgetImpactCents, or timelineImpactDays to the insert", async () => {
    const captured: Record<string, unknown>[] = [];
    const db = makeDb(captured);
    const svc = new PortalClientService(db);
    await svc.submitChangeRequest("org-1", "mem-1", null, 5, { title: "CR title", description: "Details" });

    expect(captured).toHaveLength(1);
    const inserted = captured[0];
    expect(inserted).not.toHaveProperty("impact");
    expect(inserted).not.toHaveProperty("estimateMinutes");
    expect(inserted).not.toHaveProperty("budgetImpactCents");
    expect(inserted).not.toHaveProperty("timelineImpactDays");
    expect(inserted).toHaveProperty("title", "CR title");
    expect(inserted).toHaveProperty("status", "submitted");
  });
});

describe("PortalClientService.getProjectOverview — capabilities included in response", () => {
  function makeOverviewDb(grant: {
    canViewMilestones: boolean;
    canViewTasks: boolean;
    canViewAttachments: boolean;
    canViewComments: boolean;
    canSubmitChangeRequests: boolean;
  }): Db {
    const grantRow = {
      organizationId: "org-1",
      portalMembershipId: "mem-1",
      projectId: 5,
      status: "ACTIVE",
      expiresAt: null,
      ...grant,
    };
    const grantWhere = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([grantRow]) });
    const projectWhere = jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue([{ id: 5, name: "P", key: "P5", status: "active", startDate: null, targetEndDate: null }]),
    });
    const emptyChain = {
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    return {
      select: jest.fn()
        .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ where: grantWhere }) })
        .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ where: projectWhere }) })
        .mockReturnValue(emptyChain),
    } as unknown as Db;
  }

  it("returns capabilities that mirror the grant when all flags are false", async () => {
    const grant = { canViewMilestones: false, canViewTasks: false, canViewAttachments: false, canViewComments: false, canSubmitChangeRequests: false };
    const svc = new PortalClientService(makeOverviewDb(grant));
    const result = await svc.getProjectOverview("org-1", "mem-1", 5);
    expect(result.capabilities).toEqual(grant);
  });

  it("returns capabilities that mirror the grant when all flags are true", async () => {
    const grant = { canViewMilestones: true, canViewTasks: true, canViewAttachments: true, canViewComments: true, canSubmitChangeRequests: true };
    const svc = new PortalClientService(makeOverviewDb(grant));
    const result = await svc.getProjectOverview("org-1", "mem-1", 5);
    expect(result.capabilities).toEqual(grant);
  });

  it("returns capabilities with mixed flags matching the grant exactly — not a hardcoded object", async () => {
    const grant = { canViewMilestones: true, canViewTasks: false, canViewAttachments: false, canViewComments: true, canSubmitChangeRequests: false };
    const svc = new PortalClientService(makeOverviewDb(grant));
    const result = await svc.getProjectOverview("org-1", "mem-1", 5);
    expect(result.capabilities.canViewMilestones).toBe(true);
    expect(result.capabilities.canViewTasks).toBe(false);
    expect(result.capabilities.canViewAttachments).toBe(false);
    expect(result.capabilities.canViewComments).toBe(true);
    expect(result.capabilities.canSubmitChangeRequests).toBe(false);
  });

  it("response includes all five capability keys", async () => {
    const grant = { canViewMilestones: false, canViewTasks: false, canViewAttachments: false, canViewComments: false, canSubmitChangeRequests: false };
    const svc = new PortalClientService(makeOverviewDb(grant));
    const result = await svc.getProjectOverview("org-1", "mem-1", 5);
    expect(result.capabilities).toHaveProperty("canViewMilestones");
    expect(result.capabilities).toHaveProperty("canViewTasks");
    expect(result.capabilities).toHaveProperty("canViewAttachments");
    expect(result.capabilities).toHaveProperty("canViewComments");
    expect(result.capabilities).toHaveProperty("canSubmitChangeRequests");
  });
});
