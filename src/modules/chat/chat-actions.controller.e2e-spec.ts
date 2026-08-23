import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { stubMembershipState } from "../../../test/helpers/membership-state";
import { AccessService } from "../access/access.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { MfaPolicyService } from "../access/mfa-policy.service";
import { makeMfaPolicyStub } from "test/helpers/mfa-policy-stub";

const RBAC_E2E_DATABASE_URL = process.env.RBAC_E2E_DATABASE_URL;
const describeWithDb = RBAC_E2E_DATABASE_URL ? describe : describe.skip;

describe("ChatActions auth (e2e, no DB required)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp();
  });

  afterAll(async () => app.close());

  const protectedRoutes: ReadonlyArray<["post", string]> = [
    ["post", "/chat/actions/create-task-from-message"],
    ["post", "/chat/actions/assign-ticket"],
    ["post", "/chat/actions/set-due-date"],
    ["post", "/chat/actions/ticket-status"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (_method, path) => {
    const res = await request(app.getHttpServer()).post(path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("403 on POST /chat/actions/create-task-from-message without build:tickets:create", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/chat/actions/create-task-from-message")
      .set("Authorization", `Bearer ${token}`)
      .send({ channelId: 1, messageId: 1, projectId: 1, type: "TASK" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /chat/actions/assign-ticket without build:tickets:assign", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/chat/actions/assign-ticket")
      .set("Authorization", `Bearer ${token}`)
      .send({ channelId: 1, projectId: 1, ticketId: 1, assigneeId: "user_2" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /chat/actions/set-due-date without build:tickets:update", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/chat/actions/set-due-date")
      .set("Authorization", `Bearer ${token}`)
      .send({ channelId: 1, projectId: 1, ticketId: 1, dueDate: "2026-12-31" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /chat/actions/ticket-status without build:tickets:update", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/chat/actions/ticket-status")
      .set("Authorization", `Bearer ${token}`)
      .send({ channelId: 1, projectId: 1, ticketId: 1, nextStatus: "IN_PROGRESS" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });
});

const mockAccessServiceAllowed = {
  resolveUserPermissions: jest.fn().mockResolvedValue(
    new Map<string, "all" | "own" | "team" | "none">([
      ["build:tickets:create", "all"],
      ["build:tickets:assign", "all"],
      ["build:tickets:update", "all"],
    ]),
  ),
  isModuleEnabled: jest.fn().mockResolvedValue(true),
};

function chatQ(value: unknown[]): Promise<unknown[]> & { limit: jest.Mock } {
  const p = Promise.resolve(value);
  return Object.assign(p, { limit: jest.fn().mockResolvedValue(value) }) as unknown as Promise<unknown[]> & { limit: jest.Mock };
}

const mockDbNoMembership = {
  query: {
    projectMembers: { findFirst: jest.fn().mockResolvedValue(null) },
    chatMessages: { findFirst: jest.fn().mockResolvedValue(null) },
    projects: { findFirst: jest.fn().mockResolvedValue(null) },
    tickets: { findFirst: jest.fn().mockResolvedValue(null) },
  },
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  innerJoin: jest.fn().mockReturnThis(),
  leftJoin: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnValue(chatQ([])),
  limit: jest.fn().mockResolvedValue([]),
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([]),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  execute: jest.fn().mockResolvedValue([]),
  __client: { end: jest.fn().mockResolvedValue(undefined) },
  transaction: jest.fn().mockImplementation(
    async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDbNoMembership),
  ),
};

describeWithDb("ChatActions membership-forbidden path (e2e, mocked)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= process.env.RBAC_E2E_DATABASE_URL ?? "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);

    const ref = await stubMembershipState(
      Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(AccessService)
        .useValue(mockAccessServiceAllowed)
        .overrideProvider(DRIZZLE)
        .useValue(mockDbNoMembership)
        .overrideProvider(MfaPolicyService)
        .useValue(makeMfaPolicyStub()),
      { member_1: { role: "MEMBER" }, owner_1: { role: "OWNER", isOwner: true } },
    ).compile();

    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    mockAccessServiceAllowed.resolveUserPermissions.mockResolvedValue(
      new Map<string, "all" | "own" | "team" | "none">([
        ["build:tickets:create", "all"],
        ["build:tickets:assign", "all"],
        ["build:tickets:update", "all"],
      ]),
    );
    mockAccessServiceAllowed.isModuleEnabled.mockResolvedValue(true);
    mockDbNoMembership.query.projectMembers.findFirst.mockResolvedValue(null);
    mockDbNoMembership.query.chatMessages.findFirst.mockResolvedValue(null);
    mockDbNoMembership.query.projects.findFirst.mockResolvedValue({ key: "WEB" });
    // The record exists and the caller can read it; the only thing standing
    // between them and the write is project membership. Without a real ticket
    // these cases would 404 before the membership check they exist to prove.
    mockDbNoMembership.query.tickets.findFirst.mockResolvedValue({
      id: 1,
      status: "TODO",
      assigneeId: null,
      dueDate: null,
      projectId: 1,
    });
    mockDbNoMembership.where.mockReturnValue(chatQ([{ content: "from chat" }]));
    mockDbNoMembership.limit.mockResolvedValue([{ content: "from chat" }]);
  });

  it("403 CHAT_ACTION_FORBIDDEN on POST /chat/actions/create-task-from-message when caller is not a project member", async () => {
    const token = await signToken({ sub: "member_1" });
    const res = await request(app.getHttpServer())
      .post("/chat/actions/create-task-from-message")
      .set("Authorization", `Bearer ${token}`)
      .send({ channelId: 1, messageId: 1, projectId: 1, type: "TASK" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: "CHAT_ACTION_FORBIDDEN",
      message: "Not authorized to perform this chat action",
    });
    expect(mockDbNoMembership.query.projectMembers.findFirst).toHaveBeenCalledTimes(1);
  });

  it("403 CHAT_ACTION_FORBIDDEN on POST /chat/actions/assign-ticket when caller is not a project member", async () => {
    const token = await signToken({ sub: "member_1" });
    const res = await request(app.getHttpServer())
      .post("/chat/actions/assign-ticket")
      .set("Authorization", `Bearer ${token}`)
      .send({ channelId: 1, projectId: 1, ticketId: 1, assigneeId: "user_2" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: "CHAT_ACTION_FORBIDDEN",
      message: "Not authorized to perform this chat action",
    });
    expect(mockDbNoMembership.query.projectMembers.findFirst).toHaveBeenCalledTimes(1);
  });

  it("403 CHAT_ACTION_FORBIDDEN on POST /chat/actions/set-due-date when caller is not a project member", async () => {
    const token = await signToken({ sub: "member_1" });
    const res = await request(app.getHttpServer())
      .post("/chat/actions/set-due-date")
      .set("Authorization", `Bearer ${token}`)
      .send({ channelId: 1, projectId: 1, ticketId: 1, dueDate: "2026-12-31" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: "CHAT_ACTION_FORBIDDEN",
      message: "Not authorized to perform this chat action",
    });
    expect(mockDbNoMembership.query.projectMembers.findFirst).toHaveBeenCalledTimes(1);
  });

  it("org owners skip the membership DB check entirely on POST /chat/actions/create-task-from-message", async () => {
    const token = await signToken({ sub: "owner_1" });
    await request(app.getHttpServer())
      .post("/chat/actions/create-task-from-message")
      .set("Authorization", `Bearer ${token}`)
      .send({ channelId: 1, messageId: 1, projectId: 1, type: "TASK" });
    expect(mockDbNoMembership.query.projectMembers.findFirst).not.toHaveBeenCalled();
  });
});
