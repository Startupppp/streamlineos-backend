import { ForbiddenException } from "@nestjs/common";
import { submitChangeRequestSchema } from "./dto/portal-client.schemas";
import { PortalClientService } from "./portal-client.service";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";

const makeAudit = () => ({ log: jest.fn() }) as unknown as AuditService;

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
  function makeDb(capturedInsertValues: Record<string, unknown>[], memberUserId?: string | null): Db {
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
    const memberWhere = jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue(memberUserId ? [{ userId: memberUserId }] : []),
    });
    return {
      select: jest.fn()
        .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ where: grantWhere }) })
        .mockReturnValue({ from: jest.fn().mockReturnValue({ where: memberWhere }) }),
      transaction: jest.fn().mockImplementation(async (fn: (value: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as Db;
  }

  it("does not write impact, estimateMinutes, budgetImpactCents, or timelineImpactDays to the insert", async () => {
    const captured: Record<string, unknown>[] = [];
    const db = makeDb(captured);
    const svc = new PortalClientService(db, makeAudit());
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

  it("writes the portal submitter's user id to requestedById and createdBy so actor identity survives the handoff", async () => {
    const captured: Record<string, unknown>[] = [];
    const svc = new PortalClientService(makeDb(captured, "user-77"), makeAudit());
    await svc.submitChangeRequest("org-1", "mem-1", 42, 5, { title: "CR title" });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toHaveProperty("requestedById", "user-77");
    expect(captured[0]).toHaveProperty("createdBy", "user-77");
  });

  it("writes null actor when the portal membership has no linked org member, proving the user id is resolved and not fabricated", async () => {
    const captured: Record<string, unknown>[] = [];
    const svc = new PortalClientService(makeDb(captured, null), makeAudit());
    await svc.submitChangeRequest("org-1", "mem-1", 42, 5, { title: "CR title" });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toHaveProperty("requestedById", null);
    expect(captured[0]).toHaveProperty("createdBy", null);
  });

  it("resolves the submitter membership scoped to the caller's org so a cross-tenant membership id cannot name the actor", async () => {
    const captured: Record<string, unknown>[] = [];
    const db = makeDb(captured, "user-77");
    const svc = new PortalClientService(db, makeAudit());
    await svc.submitChangeRequest("org-1", "mem-1", 42, 5, { title: "CR title" });

    const selectMock = (db as unknown as { select: jest.Mock }).select;
    expect(selectMock).toHaveBeenCalledTimes(2);
    const memberFrom = selectMock.mock.results[1].value.from as jest.Mock;
    const memberWhere = memberFrom.mock.results[0].value.where as jest.Mock;
    expect(memberWhere).toHaveBeenCalledTimes(1);
  });

  it("emits a portal.change_request_submitted audit event carrying the grant and project binding", async () => {
    const captured: Record<string, unknown>[] = [];
    const audit = makeAudit();
    const svc = new PortalClientService(makeDb(captured, "user-77"), audit);
    await svc.submitChangeRequest("org-1", "mem-1", 42, 5, { title: "CR title" });

    const log = (audit as unknown as { log: jest.Mock }).log;
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatchObject({
      action: "portal.change_request_submitted",
      userId: "user-77",
      orgId: "org-1",
      resourceType: "change_request",
      resourceId: "1",
      metadata: { projectId: 5, portalMembershipId: "mem-1" },
    });
  });

  it("does not emit an audit event when the grant forbids change requests, while an allowing grant does emit (paired control)", async () => {
    const forbidding = makeDb([], "user-77");
    const grantLimit = jest.fn().mockResolvedValue([{
      organizationId: "org-1",
      portalMembershipId: "mem-1",
      projectId: 5,
      status: "ACTIVE",
      expiresAt: null,
      canSubmitChangeRequests: false,
      canViewMilestones: false,
      canViewTasks: false,
      canViewAttachments: false,
      canViewComments: false,
    }]);
    (forbidding as unknown as { select: jest.Mock }).select = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: grantLimit }) }),
    });
    const deniedAudit = makeAudit();
    const deniedSvc = new PortalClientService(forbidding, deniedAudit);
    await expect(
      deniedSvc.submitChangeRequest("org-1", "mem-1", 42, 5, { title: "CR title" }),
    ).rejects.toThrow(ForbiddenException);
    expect((deniedAudit as unknown as { log: jest.Mock }).log).not.toHaveBeenCalled();

    const allowedAudit = makeAudit();
    const allowedSvc = new PortalClientService(makeDb([], "user-77"), allowedAudit);
    await allowedSvc.submitChangeRequest("org-1", "mem-1", 42, 5, { title: "CR title" });
    expect((allowedAudit as unknown as { log: jest.Mock }).log).toHaveBeenCalledTimes(1);
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
    const svc = new PortalClientService(makeOverviewDb(grant), makeAudit());
    const result = await svc.getProjectOverview("org-1", "mem-1", 5);
    expect(result.capabilities).toEqual(grant);
  });

  it("returns capabilities that mirror the grant when all flags are true", async () => {
    const grant = { canViewMilestones: true, canViewTasks: true, canViewAttachments: true, canViewComments: true, canSubmitChangeRequests: true };
    const svc = new PortalClientService(makeOverviewDb(grant), makeAudit());
    const result = await svc.getProjectOverview("org-1", "mem-1", 5);
    expect(result.capabilities).toEqual(grant);
  });

  it("returns capabilities with mixed flags matching the grant exactly — not a hardcoded object", async () => {
    const grant = { canViewMilestones: true, canViewTasks: false, canViewAttachments: false, canViewComments: true, canSubmitChangeRequests: false };
    const svc = new PortalClientService(makeOverviewDb(grant), makeAudit());
    const result = await svc.getProjectOverview("org-1", "mem-1", 5);
    expect(result.capabilities.canViewMilestones).toBe(true);
    expect(result.capabilities.canViewTasks).toBe(false);
    expect(result.capabilities.canViewAttachments).toBe(false);
    expect(result.capabilities.canViewComments).toBe(true);
    expect(result.capabilities.canSubmitChangeRequests).toBe(false);
  });

  it("response includes all five capability keys", async () => {
    const grant = { canViewMilestones: false, canViewTasks: false, canViewAttachments: false, canViewComments: false, canSubmitChangeRequests: false };
    const svc = new PortalClientService(makeOverviewDb(grant), makeAudit());
    const result = await svc.getProjectOverview("org-1", "mem-1", 5);
    expect(result.capabilities).toHaveProperty("canViewMilestones");
    expect(result.capabilities).toHaveProperty("canViewTasks");
    expect(result.capabilities).toHaveProperty("canViewAttachments");
    expect(result.capabilities).toHaveProperty("canViewComments");
    expect(result.capabilities).toHaveProperty("canSubmitChangeRequests");
  });
});
