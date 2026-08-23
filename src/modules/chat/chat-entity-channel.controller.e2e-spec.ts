import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { Test } from "@nestjs/testing";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { stubMembershipState } from "../../../test/helpers/membership-state";
import { AccessService } from "../access/access.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { MfaPolicyService } from "../access/mfa-policy.service";
import { makeMfaPolicyStub } from "test/helpers/mfa-policy-stub";

const RBAC_E2E_DATABASE_URL = process.env.RBAC_E2E_DATABASE_URL;
const describeWithDb = RBAC_E2E_DATABASE_URL ? describe : describe.skip;

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
  },
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  innerJoin: jest.fn().mockReturnThis(),
  leftJoin: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnValue(q([TICKET_ROW])),
  limit: jest.fn().mockResolvedValue([TICKET_ROW]),
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([{ id: 1, name: "Ticket", type: "GROUP" }]),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  execute: jest.fn().mockResolvedValue([]),
  __client: { end: jest.fn().mockResolvedValue(undefined) },
  transaction: jest
    .fn()
    .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb)),
};

describeWithDb("Chat entity channel access (e2e, mocked)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      process.env.RBAC_E2E_DATABASE_URL ?? "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);

    const ref = await stubMembershipState(
      Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(AccessService)
        .useValue(mockAccess)
        .overrideProvider(DRIZZLE)
        .useValue(mockDb)
        .overrideProvider(MfaPolicyService)
        .useValue(makeMfaPolicyStub()),
      { member_1: { role: "MEMBER" } },
    ).compile();

    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    mockAccess.isModuleEnabled.mockResolvedValue(true);
    mockDb.query.chatChannels.findFirst.mockResolvedValue(null);
    mockDb.where.mockReturnValue(q([TICKET_ROW]));
    mockDb.limit.mockResolvedValue([TICKET_ROW]);
  });

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
});
