import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { Test } from "@nestjs/testing";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { stubMembershipState } from "../../../test/helpers/membership-state";
import { AccessService } from "../access/access.service";
import {
  moduleAvailabilityResolver,
  type ModuleAvailabilityResult,
} from "../../common/rbac/module-availability";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { MfaPolicyService } from "../access/mfa-policy.service";
import { makeMfaPolicyStub } from "test/helpers/mfa-policy-stub";
import { installFixtureRegionRegistry } from "test/helpers/e2e-app";
import { PayrollJobsWorkerService } from "../payroll/jobs/payroll-jobs-worker.service";
import { PayrollCalendarReminderScheduler } from "../payroll/insights/payroll-calendar-reminder.scheduler";
import { NotificationDeliveryWorker } from "../notifications/notification-delivery-worker.service";
import { PermissionCatalogSyncService } from "../rbac/permission-catalog-sync.service";

import { describeWithMockedDb } from "test/helpers/db-describe";

type Scope = "all" | "own" | "team" | "none";

/**
 * Regression net for the leak this seam closed: `GET /chat/channels/entity/...`
 * was gated only on `chat:channels:read`, then read the record's own title out
 * of Build and CRM with no permission check of any kind — so any chat user
 * could harvest ticket titles, project names and customer names by walking ids.
 */
const mockAccess = {
  resolveUserPermissions: jest.fn<Promise<Map<string, Scope>>, unknown[]>(),
  isModuleEnabled: jest.fn().mockResolvedValue(true),
  scopeFor: jest.fn(async (_ctx: unknown, key: string): Promise<Scope> => {
    const map = await mockAccess.resolveUserPermissions();
    return map.get(key) ?? "none";
  }),
  getModuleState: jest.fn(
    async (orgId: string, moduleKey: string): Promise<boolean | undefined> =>
      mockAccess.isModuleEnabled(orgId, moduleKey),
  ),
  moduleAvailability: async (
    user: { orgId: string },
    moduleKey: string,
  ): Promise<ModuleAvailabilityResult> =>
    (await mockAccess.isModuleEnabled(user.orgId, moduleKey))
      ? { available: true }
      : { available: false, reason: "org-disabled" },
  buildModuleAvailabilityResolver: (
    getModuleMap: (orgId: string) => Promise<Record<string, boolean>>,
  ) =>
    moduleAvailabilityResolver(
      {
        isCoreModule: () => false,
        getModuleMap,
        getPlanLockedModules: async () => [],
      },
      { getUserDeniedModules: async () => new Set<string>() },
    ),
};

function q(value: unknown[]): Promise<unknown[]> & { limit: jest.Mock } {
  const p = Promise.resolve(value);
  return Object.assign(p, {
    limit: jest.fn().mockResolvedValue(value),
  }) as unknown as Promise<unknown[]> & { limit: jest.Mock };
}

const TICKET_ROW = {
  id: 7,
  title: "Refund pipeline is dropping events",
  status: "IN_PROGRESS",
  ticketNumber: 31,
  projectKey: "WEB",
};

const mockDb = {
  query: {
    chatChannels: { findFirst: jest.fn().mockResolvedValue(null) },
    chatChannelMembers: { findFirst: jest.fn().mockResolvedValue(null) },
    chatMessages: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({ id: 1, channelId: 1 }),
    },
  },
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  innerJoin: jest.fn().mockReturnThis(),
  leftJoin: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnValue(q([TICKET_ROW])),
  limit: jest.fn().mockResolvedValue([TICKET_ROW]),
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  onConflictDoUpdate: jest.fn().mockReturnThis(),
  onConflictDoNothing: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([{ id: 1, name: "Ticket", type: "GROUP" }]),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockResolvedValue([]),
  execute: jest.fn().mockResolvedValue([]),
  __client: { end: jest.fn().mockResolvedValue(undefined) },
  transaction: jest
    .fn()
    .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb)),
};

describeWithMockedDb("Chat entity channel access (e2e, mocked)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      process.env.RBAC_E2E_DATABASE_URL ?? "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    process.env.ADMISSION_ENABLED = "false";
    process.env.NOTIFICATIONS_INPROCESS_WORKER = "false";
    process.env.HR_EXPORT_WORKER_ENABLED = "false";
    process.env.PAYROLL_EXPORT_WORKER_ENABLED = "false";
    process.env.EXPENSE_EXPORT_WORKER_ENABLED = "false";
    process.env.FINANCE_REPORT_EXPORT_WORKER_ENABLED = "false";
    process.env.GDPR_EXPORT_WORKER_ENABLED = "false";

    const ref = await stubMembershipState(
      Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(AccessService)
        .useValue(mockAccess)
        .overrideProvider(DRIZZLE)
        .useValue(mockDb)
        .overrideProvider(MfaPolicyService)
        .useValue(makeMfaPolicyStub())
        .overrideProvider(PayrollJobsWorkerService)
        .useValue({})
        .overrideProvider(PayrollCalendarReminderScheduler)
        .useValue({})
        .overrideProvider(NotificationDeliveryWorker)
        .useValue({})
        .overrideProvider(PermissionCatalogSyncService)
        .useValue({}),
      { member_1: { role: "MEMBER" } },
    ).compile();

    installFixtureRegionRegistry(ref.get<Db>(DRIZZLE));
    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    mockAccess.isModuleEnabled.mockResolvedValue(true);
    const now = new Date();
    mockDb.query.chatChannels.findFirst.mockResolvedValue({
      id: 1,
      orgId: "org_1",
      name: "Test Channel",
      type: "GROUP",
      description: null,
      avatarUrl: null,
      isArchived: false,
      entityType: null,
      entityId: null,
      isPinned: false,
      isPrivate: true,
      messageCount: 0,
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now,
      members: [],
    });
    mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ id: 1 });
    mockDb.query.chatMessages.findMany.mockResolvedValue([]);
    mockDb.query.chatMessages.findFirst.mockResolvedValue({
      id: 1,
      orgId: "org_1",
      channelId: 1,
      senderMembershipId: null,
      content: "parent message",
      replyToId: null,
      isEdited: false,
      isDeleted: false,
      messageType: "text",
      metadata: null,
      actionStatus: null,
      clientKey: null,
      channelPosition: 1,
      createdAt: now,
      updatedAt: now,
      attachments: [],
      senderMembership: null,
      reactions: [],
      replyTo: null,
    });
    mockDb.where.mockReturnValue(q([TICKET_ROW]));
    mockDb.limit.mockResolvedValue([TICKET_ROW]);
  });

  const messageCarryingTicketRef = [
    {
      id: 1,
      orgId: "org_1",
      channelId: 1,
      senderMembershipId: null,
      content: "look at this",
      replyToId: null,
      isEdited: false,
      isDeleted: false,
      messageType: "text",
      metadata: { entities: [{ type: "ticket", id: "7" }] },
      actionStatus: null,
      clientKey: null,
      channelPosition: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      attachments: [],
      senderMembership: null,
      reactions: [],
      replyTo: null,
    },
  ];

  const messagesOf = (body: Record<string, unknown>) => {
    const payload = (body["data"] ?? body) as
      | { messages?: unknown[]; replies?: unknown[] }
      | unknown[];
    const messages = Array.isArray(payload)
      ? payload
      : (payload.messages ?? payload.replies);
    if (!Array.isArray(messages))
      throw new Error(`no messages in response: ${JSON.stringify(body)}`);
    return messages as { metadata: { entities: { card: unknown }[] } }[];
  };

  const grant = (...keys: string[]) =>
    mockAccess.resolveUserPermissions.mockResolvedValue(
      new Map<string, Scope>(keys.map((key) => [key, "all"])),
    );

  it("404s a ticket channel for a chat user who cannot read tickets", async () => {
    grant("chat:channels:read");
    const token = await signToken({
      sub: "member_1",
      permissions: ["chat:channels:read"],
      enabledModules: ALL_MODULES,
    });

    const res = await request(app.getHttpServer())
      .get("/chat/channels/entity/task/7")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(TICKET_ROW.title);
  });

  it("404s a nonexistent record identically, so the API is not an existence oracle", async () => {
    grant("chat:channels:read", "build:tickets:view");
    mockDb.where.mockReturnValue(q([]));
    mockDb.limit.mockResolvedValue([]);
    const token = await signToken({
      sub: "member_1",
      permissions: ["chat:channels:read"],
      enabledModules: ALL_MODULES,
    });

    const res = await request(app.getHttpServer())
      .get("/chat/channels/entity/task/999999")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it("404s a type no adapter claims", async () => {
    grant("chat:channels:read", "build:tickets:view");
    const token = await signToken({
      sub: "member_1",
      permissions: ["chat:channels:read"],
      enabledModules: ALL_MODULES,
    });

    const res = await request(app.getHttpServer())
      .get("/chat/channels/entity/unicorn/7")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it("404s when the owning module is disabled for the org", async () => {
    grant("chat:channels:read", "build:tickets:view");
    mockAccess.isModuleEnabled.mockImplementation(
      async (_orgId: string, moduleKey: string) => moduleKey !== "build",
    );
    const token = await signToken({
      sub: "member_1",
      permissions: ["chat:channels:read"],
      enabledModules: ALL_MODULES,
    });

    const res = await request(app.getHttpServer())
      .get("/chat/channels/entity/task/7")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it("opens the channel for a chat user who can read the ticket", async () => {
    grant("chat:channels:read", "build:tickets:view");
    const token = await signToken({
      sub: "member_1",
      permissions: ["chat:channels:read"],
      enabledModules: ALL_MODULES,
    });

    const res = await request(app.getHttpServer())
      .get("/chat/channels/entity/task/7")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it("does not join the caller to an existing channel as a side effect of opening it", async () => {
    grant("chat:channels:read", "build:tickets:view");
    mockDb.query.chatChannels.findFirst.mockResolvedValue({
      id: 4,
      name: TICKET_ROW.title,
      entityType: "task",
      entityId: "7",
      members: [{ userId: "someone_else", user: { id: "someone_else" } }],
    });
    const token = await signToken({
      sub: "member_1",
      permissions: ["chat:channels:read"],
      enabledModules: ALL_MODULES,
    });

    await request(app.getHttpServer())
      .get("/chat/channels/entity/task/7")
      .set("Authorization", `Bearer ${token}`);

    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("resolves a ticket reference in scrollback for a reader who may see it", async () => {
    grant("chat:messages:read", "build:tickets:view");
    mockDb.query.chatMessages.findMany.mockResolvedValue(messageCarryingTicketRef);
    const token = await signToken({
      sub: "member_1",
      permissions: ["chat:messages:read"],
      enabledModules: ALL_MODULES,
    });

    const res = await request(app.getHttpServer())
      .get("/chat/channels/1/messages")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const [entity] = messagesOf(res.body)[0].metadata.entities;
    expect(entity.card).toMatchObject({ title: TICKET_ROW.title });
  });

  it("withholds the same reference from a reader whose ticket access was revoked", async () => {
    grant("chat:messages:read");
    mockDb.query.chatMessages.findMany.mockResolvedValue(messageCarryingTicketRef);
    const token = await signToken({
      sub: "member_1",
      permissions: ["chat:messages:read"],
      enabledModules: ALL_MODULES,
    });

    const res = await request(app.getHttpServer())
      .get("/chat/channels/1/messages")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const [entity] = messagesOf(res.body)[0].metadata.entities;
    expect(entity.card).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(TICKET_ROW.title);
  });

  it("serves a CRM deal through the same route shape as a Build ticket", async () => {
    grant("chat:channels:read", "crm:deals:read");
    const dealRow = { id: 3, name: "Acme renewal", stage: "NEGOTIATION" };
    mockDb.where.mockReturnValue(q([dealRow]));
    mockDb.limit.mockResolvedValue([dealRow]);
    const token = await signToken({
      sub: "member_1",
      permissions: ["chat:channels:read"],
      enabledModules: ALL_MODULES,
    });

    const res = await request(app.getHttpServer())
      .get("/chat/channels/entity/deal/3")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it("withholds a reference from a poller whose ticket access was revoked", async () => {
    grant("chat:messages:read");
    mockDb.query.chatMessages.findMany.mockResolvedValue(messageCarryingTicketRef);
    const token = await signToken({
      sub: "member_1",
      permissions: ["chat:messages:read"],
      enabledModules: ALL_MODULES,
    });

    const res = await request(app.getHttpServer())
      .get("/chat/channels/1/messages/poll?since=2026-01-01T00:00:00.000Z")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const [entity] = messagesOf(res.body)[0].metadata.entities;
    expect(entity.card).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(TICKET_ROW.title);
  });

  it("resolves a reference for a poller who may see the ticket", async () => {
    grant("chat:messages:read", "build:tickets:view");
    mockDb.query.chatMessages.findMany.mockResolvedValue(messageCarryingTicketRef);
    const token = await signToken({
      sub: "member_1",
      permissions: ["chat:messages:read"],
      enabledModules: ALL_MODULES,
    });

    const res = await request(app.getHttpServer())
      .get("/chat/channels/1/messages/poll?since=2026-01-01T00:00:00.000Z")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const [entity] = messagesOf(res.body)[0].metadata.entities;
    expect(entity.card).toMatchObject({ title: TICKET_ROW.title });
  });

  it("withholds a reference in a thread from a reader whose ticket access was revoked", async () => {
    grant("chat:messages:read");
    mockDb.query.chatMessages.findMany.mockResolvedValue(messageCarryingTicketRef);
    const token = await signToken({
      sub: "member_1",
      permissions: ["chat:messages:read"],
      enabledModules: ALL_MODULES,
    });

    const res = await request(app.getHttpServer())
      .get("/chat/channels/1/messages/1/thread")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const [entity] = messagesOf(res.body)[0].metadata.entities;
    expect(entity.card).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(TICKET_ROW.title);
  });
});
