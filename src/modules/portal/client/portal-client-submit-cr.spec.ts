import { ForbiddenException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import { submitChangeRequestSchema } from "./dto/portal-client.schemas";
import { PortalClientController } from "./portal-client.controller";
import { PortalClientService } from "./portal-client.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { IDEMPOTENCY_COMMAND } from "../../../common/idempotency/idempotency.constants";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { effectiveRateLimit } from "../../../common/ratelimit/rate-limit.service";
import { RATE_LIMIT_TIER } from "../../../common/ratelimit/use-rate-limit.decorator";
import { PortalProjectionService } from "../../build/client-portal/portal-projection.service";

type PortalAudit = jest.Mocked<Pick<AuditService, "log" | "logCritical">>;

const makeAudit = (): PortalAudit => ({ log: jest.fn(), logCritical: jest.fn() });

async function makeService(db: object, audit: PortalAudit = makeAudit()): Promise<PortalClientService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      PortalClientService,
      { provide: DRIZZLE, useValue: db },
      { provide: AuditService, useValue: audit },
      {
        provide: PortalProjectionService,
        useValue: {
          build: jest.fn().mockResolvedValue({
            milestones: [],
            tasks: [],
            attachments: [],
            comments: [],
          }),
        },
      },
    ],
  }).compile();
  return moduleRef.get(PortalClientService);
}

const ACTIVE_GRANT = {
  projectClientGrantId: 9,
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
};

function makeTransactionalSubmitDb(
  grantWhereCalls: unknown[] = [],
  grantLockCalls: string[] = [],
  grantRows: unknown[] = [ACTIVE_GRANT],
) {
  const grantFor = jest.fn().mockImplementation((lock: string) => {
    grantLockCalls.push(lock);
    return Promise.resolve(grantRows);
  });
  const grantLimit = jest.fn().mockReturnValue({ for: grantFor });
  const grantWhere = jest.fn().mockImplementation((condition: unknown) => {
    grantWhereCalls.push(condition);
    return { limit: grantLimit };
  });
  const maxWhere = jest.fn().mockResolvedValue([{ maxNum: 0 }]);
  const tx = {
    execute: jest.fn().mockResolvedValue(undefined),
    select: jest.fn()
      .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ where: grantWhere }) })
      .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ where: maxWhere }) }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{
          id: 1,
          crNumber: 1,
          title: "CR title",
          status: "submitted",
          createdAt: new Date(),
        }]),
      }),
    }),
  };
  return {
    select: jest.fn().mockImplementation(() => {
      throw new Error("grant lookup escaped the write transaction");
    }),
    transaction: jest.fn().mockImplementation(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx)),
    testTx: tx,
  };
}

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
  function makeDb(
    capturedInsertValues: Record<string, unknown>[],
    memberUserId?: string | null,
    canSubmitChangeRequests = true,
  ): Db {
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
    const grantFor = jest.fn().mockResolvedValue([{
      ...ACTIVE_GRANT,
      canSubmitChangeRequests,
    }]);
    const grantWhere = jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnValue({ for: grantFor }),
    });
    const maxWhere = jest.fn().mockResolvedValue([{ maxNum: 0 }]);
    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: jest.fn()
        .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ where: grantWhere }) })
        .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ where: maxWhere }) }),
      insert: jest.fn().mockReturnValue({ values: txInsert }),
    };
    const memberWhere = jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue(memberUserId ? [{ userId: memberUserId }] : []),
    });
    return {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: memberWhere }) }),
      transaction: jest.fn().mockImplementation(async (fn: (value: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as Db;
  }

  it("does not write impact, estimateMinutes, budgetImpactCents, or timelineImpactDays to the insert", async () => {
    const captured: Record<string, unknown>[] = [];
    const db = makeDb(captured);
    const svc = await makeService(db);
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
    const svc = await makeService(makeDb(captured, "user-77"));
    await svc.submitChangeRequest("org-1", "mem-1", 42, 5, { title: "CR title" });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toHaveProperty("requestedById", "user-77");
    expect(captured[0]).toHaveProperty("createdBy", "user-77");
  });

  it("writes null actor when the portal membership has no linked org member, proving the user id is resolved and not fabricated", async () => {
    const captured: Record<string, unknown>[] = [];
    const svc = await makeService(makeDb(captured, null));
    await svc.submitChangeRequest("org-1", "mem-1", 42, 5, { title: "CR title" });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toHaveProperty("requestedById", null);
    expect(captured[0]).toHaveProperty("createdBy", null);
  });

  it("resolves the submitter membership scoped to the caller's org so a cross-tenant membership id cannot name the actor", async () => {
    const captured: Record<string, unknown>[] = [];
    const db = makeDb(captured, "user-77");
    const svc = await makeService(db);
    await svc.submitChangeRequest("org-1", "mem-1", 42, 5, { title: "CR title" });

    const selectMock = (db as unknown as { select: jest.Mock }).select;
    expect(selectMock).toHaveBeenCalledTimes(1);
    const memberFrom = selectMock.mock.results[0].value.from as jest.Mock;
    const memberWhere = memberFrom.mock.results[0].value.where as jest.Mock;
    expect(memberWhere).toHaveBeenCalledTimes(1);
  });

  it("emits a portal.change_request_submitted audit event carrying the grant and project binding", async () => {
    const captured: Record<string, unknown>[] = [];
    const audit = makeAudit();
    const svc = await makeService(makeDb(captured, "user-77"), audit);
    await svc.submitChangeRequest("org-1", "mem-1", 42, 5, { title: "CR title" });

    const log = audit.logCritical;
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
    const forbidding = makeDb([], "user-77", false);
    const deniedAudit = makeAudit();
    const deniedSvc = await makeService(forbidding, deniedAudit);
    await expect(
      deniedSvc.submitChangeRequest("org-1", "mem-1", 42, 5, { title: "CR title" }),
    ).rejects.toThrow(ForbiddenException);
    expect(deniedAudit.logCritical).not.toHaveBeenCalled();

    const allowedAudit = makeAudit();
    const allowedSvc = await makeService(makeDb([], "user-77"), allowedAudit);
    await allowedSvc.submitChangeRequest("org-1", "mem-1", 42, 5, { title: "CR title" });
    expect(allowedAudit.logCritical).toHaveBeenCalledTimes(1);
  });
});

describe("PortalClientService.submitChangeRequest — transaction and tenant boundary", () => {
  it("checks the active grant inside the same transaction as the insert", async () => {
    const grantLockCalls: string[] = [];
    const svc = await makeService(makeTransactionalSubmitDb([], grantLockCalls));

    await expect(
      svc.submitChangeRequest("org-1", "mem-1", null, 5, { title: "CR title" }),
    ).resolves.toMatchObject({ id: 1, status: "submitted" });
    expect(grantLockCalls).toEqual(["update"]);
  });

  it("binds org, membership, and project in the transactional grant predicate", async () => {
    const whereCalls: unknown[] = [];
    const svc = await makeService(makeTransactionalSubmitDb(whereCalls));

    await svc.submitChangeRequest("org-1", "mem-1", null, 5, { title: "CR title" });

    const query = new PgDialect().sqlToQuery(whereCalls[0] as Parameters<PgDialect["sqlToQuery"]>[0]);
    const querySql = query.sql.toLowerCase();
    expect(querySql).toContain("organization_id");
    expect(querySql).toContain("portal_membership_id");
    expect(querySql).toContain("project_id");
    expect(querySql).toContain("deleted_at");
    expect(querySql).toContain("portal_published_at");
    expect(querySql).toContain("is not null");
    expect(query.params).toEqual(expect.arrayContaining(["org-1", "mem-1", 5]));
  });

  it("returns the safe project denial and writes nothing when the portal is unpublished", async () => {
    const whereCalls: unknown[] = [];
    const db = makeTransactionalSubmitDb(whereCalls, [], []);
    const svc = await makeService(db);

    await expect(
      svc.submitChangeRequest("org-1", "mem-1", null, 5, { title: "CR title" }),
    ).rejects.toMatchObject({ message: "Project not found" });

    const query = new PgDialect().sqlToQuery(whereCalls[0] as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(query.sql.toLowerCase()).toContain("portal_published_at");
    expect(db.testTx.execute).not.toHaveBeenCalled();
    expect(db.testTx.insert).not.toHaveBeenCalled();
  });

  it("aborts submission when critical audit persistence fails", async () => {
    const audit = makeAudit();
    const failure = new Error("audit unavailable");
    jest.mocked(audit.logCritical).mockRejectedValueOnce(failure);
    const svc = await makeService(makeTransactionalSubmitDb(), audit);

    await expect(
      svc.submitChangeRequest("org-1", "mem-1", null, 5, { title: "CR title" }),
    ).rejects.toBe(failure);
    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe("PortalClientController.submitChangeRequest — command safety", () => {
  const handler = PortalClientController.prototype.submitChangeRequest;

  it("requires idempotency for external change-request creation", () => {
    expect(Reflect.getMetadata(IDEMPOTENCY_COMMAND, handler)).toBe(
      "portal.client.change-request.create",
    );
  });

  it("applies the registered portal write rate limit", () => {
    expect(Reflect.getMetadata(RATE_LIMIT_TIER, handler)).toBe("support:portal-ticket-create");
    expect(effectiveRateLimit("support:portal-ticket-create")).toBeGreaterThan(0);
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
    expect(guards).toContain(RateLimitGuard);
  });

  it("maps the authenticated portal membership to the command-fence principal", () => {
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
    const principalGuard = guards.find((guard) => typeof guard === "object" && guard !== null);
    const canActivate = principalGuard
      ? Reflect.get(principalGuard, "canActivate")
      : undefined;
    const request: Record<string, unknown> = {
      portalUser: { portalMembershipId: 17, organizationId: "org-1" },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    };

    expect(typeof canActivate).toBe("function");
    if (typeof canActivate !== "function") throw new Error("portal command principal guard missing");
    expect(Reflect.apply(canActivate, principalGuard, [context])).toBe(true);
    expect(request["user"]).toEqual({
      orgId: "org-1",
      userId: "portal:17",
      sessionId: "portal:17",
    });
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
    const svc = await makeService(makeOverviewDb(grant));
    const result = await svc.getProjectOverview("org-1", "mem-1", 5);
    expect(result.capabilities).toEqual(grant);
  });

  it("returns capabilities that mirror the grant when all flags are true", async () => {
    const grant = { canViewMilestones: true, canViewTasks: true, canViewAttachments: true, canViewComments: true, canSubmitChangeRequests: true };
    const svc = await makeService(makeOverviewDb(grant));
    const result = await svc.getProjectOverview("org-1", "mem-1", 5);
    expect(result.capabilities).toEqual(grant);
  });

  it("returns capabilities with mixed flags matching the grant exactly — not a hardcoded object", async () => {
    const grant = { canViewMilestones: true, canViewTasks: false, canViewAttachments: false, canViewComments: true, canSubmitChangeRequests: false };
    const svc = await makeService(makeOverviewDb(grant));
    const result = await svc.getProjectOverview("org-1", "mem-1", 5);
    expect(result.capabilities.canViewMilestones).toBe(true);
    expect(result.capabilities.canViewTasks).toBe(false);
    expect(result.capabilities.canViewAttachments).toBe(false);
    expect(result.capabilities.canViewComments).toBe(true);
    expect(result.capabilities.canSubmitChangeRequests).toBe(false);
  });

  it("response includes all five capability keys", async () => {
    const grant = { canViewMilestones: false, canViewTasks: false, canViewAttachments: false, canViewComments: false, canSubmitChangeRequests: false };
    const svc = await makeService(makeOverviewDb(grant));
    const result = await svc.getProjectOverview("org-1", "mem-1", 5);
    expect(result.capabilities).toHaveProperty("canViewMilestones");
    expect(result.capabilities).toHaveProperty("canViewTasks");
    expect(result.capabilities).toHaveProperty("canViewAttachments");
    expect(result.capabilities).toHaveProperty("canViewComments");
    expect(result.capabilities).toHaveProperty("canSubmitChangeRequests");
  });
});
