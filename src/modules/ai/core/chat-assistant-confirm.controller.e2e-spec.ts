import { type INestApplication, ForbiddenException, NotFoundException } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { AiConfirmationService } from "../confirmation/ai-confirmation.service";
import { OrgFeaturesService } from "./services/org-features.service";
import { ProjectsTicketsCreateService } from "../../build/core/tickets";
import { ChatMessagesService } from "../../chat/chat-messages.service";
import { CalendarService } from "../../calendar/calendar.service";
import { MailComposeService } from "../../mail/mail-compose.service";
import { MailAccountsService } from "../../mail/mail-accounts.service";

const STUB_TOKEN = "stub.confirmation.token";

const FULL_FLAGS = {
  aiChat: true,
  aiLeadScoring: true,
  aiEmailDraft: true,
  aiSmartNotifications: true,
  aiWeeklyRecap: true,
  supportAi: true,
};

type DenyCase = {
  action: string;
  permission: string;
  payload: Record<string, unknown>;
};

const DENY_CASES: DenyCase[] = [
  { action: "ticket.create", permission: "build:tickets:create", payload: { projectId: 1, title: "Test" } },
  {
    action: "ticket.updateStatus",
    permission: "build:tickets:update",
    payload: { ticketId: 1, status: "DONE" },
  },
  {
    action: "ticket.addComment",
    permission: "build:tickets:update",
    payload: { ticketId: 1, comment: "A comment" },
  },
  {
    action: "ticket.assign",
    permission: "build:tickets:update",
    payload: { ticketId: 1, assigneeId: "user_2" },
  },
  {
    action: "ticket.moveToCycle",
    permission: "build:tickets:update",
    payload: { ticketId: 1, cycleId: 1 },
  },
  {
    action: "calendar.createReminder",
    permission: "calendar:write",
    payload: { title: "Stand-up", startDate: "2026-01-01", endDate: "2026-01-01", timezone: "UTC" },
  },
  {
    action: "calendar.createEvent",
    permission: "calendar:write",
    payload: { title: "Team event", startDate: "2026-01-01", endDate: "2026-01-01", timezone: "UTC" },
  },
  {
    action: "calendar.scheduleMeeting",
    permission: "calendar:write",
    payload: { title: "Sync", startDate: "2026-01-01", endDate: "2026-01-01", timezone: "UTC" },
  },
  {
    action: "hr.grantRecognition",
    permission: "hr:engagement:manage",
    payload: { toUserId: "user_2", message: "Great work" },
  },
  {
    action: "hr.grantBonus",
    permission: "hr:bonuses:manage",
    payload: { employeeId: "user_2", type: "performance", amount: 1000, month: "2026-01" },
  },
  {
    action: "self.applyLeave",
    permission: "self:leaves",
    payload: { leaveTypeId: 1, startDate: "2026-01-01", endDate: "2026-01-05" },
  },
  {
    action: "self.submitExpense",
    permission: "self:expenses",
    payload: { category: "travel", amount: 100, date: "2026-01-01" },
  },
  {
    action: "self.logTimesheet",
    permission: "timesheets:entries:create",
    payload: { date: "2026-01-01", hours: 8 },
  },
  {
    action: "self.submitReferral",
    permission: "self:referrals",
    payload: { candidateName: "Jane Smith", candidateEmail: "jane@example.com" },
  },
  {
    action: "self.applyToJobOpening",
    permission: "self:job-openings",
    payload: { jobId: 1 },
  },
  {
    action: "email.send",
    permission: "chat:messages:write",
    payload: { toEmail: "a@b.com", subject: "Hi", body: "Hello there" },
  },
  {
    action: "chat.postChannel",
    permission: "chat:messages:write",
    payload: { channelId: 1, message: "Hello" },
  },
  {
    action: "chat.sendDirect",
    permission: "chat:messages:write",
    payload: { targetUserId: "user_2", message: "Hi" },
  },
  {
    action: "mail.send",
    permission: "mail:messages:send",
    payload: { accountId: 1, toEmail: "a@b.com", subject: "Hi", body: "Hello" },
  },
  {
    action: "mail.reply",
    permission: "mail:messages:send",
    payload: { threadId: "thread_1", body: "Reply body" },
  },
  {
    action: "mail.archive",
    permission: "mail:messages:manage",
    payload: { accountId: 1, messageId: "msg_1" },
  },
  { action: "crm.createLead", permission: "crm:leads:create", payload: { name: "Lead Alpha" } },
  {
    action: "crm.logActivity",
    permission: "crm:activities:manage",
    payload: { leadIdentifier: 1, type: "call" },
  },
  {
    action: "crm.updateLeadStatus",
    permission: "crm:leads:update",
    payload: { leadId: 1, status: "qualified" },
  },
];

describe("POST /chat/confirm (e2e)", () => {
  let app: INestApplication;

  const mockConfirm = jest.fn();
  const mockMarkExecuted = jest.fn();
  const mockGetFlags = jest.fn();
  const mockCreateTicket = jest.fn();
  const mockChatSend = jest.fn();
  const mockCalendarCreateEvent = jest.fn();
  const mockMailAssertOwned = jest.fn();
  const mockMailSend = jest.fn();

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        {
          provide: AiConfirmationService,
          useValue: { confirm: mockConfirm, markExecuted: mockMarkExecuted, propose: jest.fn() },
        },
        {
          provide: OrgFeaturesService,
          useValue: { getFlags: mockGetFlags },
        },
        {
          provide: ProjectsTicketsCreateService,
          useValue: { createTicket: mockCreateTicket },
        },
        {
          provide: ChatMessagesService,
          useValue: { send: mockChatSend },
        },
        {
          provide: CalendarService,
          useValue: { createEvent: mockCalendarCreateEvent },
        },
        {
          provide: MailAccountsService,
          useValue: { assertOwnedConnection: mockMailAssertOwned, listAccounts: jest.fn() },
        },
        {
          provide: MailComposeService,
          useValue: { sendMail: mockMailSend, replyMail: jest.fn(), performAction: jest.fn() },
        },
      ],
    });
  });

  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    jest.resetAllMocks();
    mockGetFlags.mockResolvedValue(FULL_FLAGS);
    mockMarkExecuted.mockResolvedValue(undefined);
  });

  it("returns 401 and UNAUTHORIZED when no bearer token is presented", async () => {
    const res = await request(app.getHttpServer())
      .post("/chat/confirm")
      .send({ token: STUB_TOKEN });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("returns 400 and VALIDATION_FAILED when the request body omits the required token field", async () => {
    const token = await signToken({ permissions: ["ai:chat:use"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/chat/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("returns 403 and FORBIDDEN when the caller lacks ai:chat:use, preventing any confirmation regardless of the token", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/chat/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ token: STUB_TOKEN });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("returns 403 and FORBIDDEN when the org aiChat feature flag is disabled, preventing execution even with ai:chat:use", async () => {
    mockGetFlags.mockResolvedValue({ ...FULL_FLAGS, aiChat: false });
    const token = await signToken({ permissions: ["ai:chat:use"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/chat/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ token: STUB_TOKEN });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns 403 and FORBIDDEN when the confirmation service rejects a structurally invalid token", async () => {
    mockConfirm.mockRejectedValue(new ForbiddenException("Invalid token format"));
    const token = await signToken({ permissions: ["ai:chat:use"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/chat/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ token: STUB_TOKEN });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns 404 and NOT_FOUND when confirming a proposal minted in another org, so the caller cannot determine whether the proposal id exists in that org", async () => {
    mockConfirm.mockRejectedValue(new NotFoundException("Proposal not found"));
    const token = await signToken({ permissions: ["ai:chat:use"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/chat/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ token: STUB_TOKEN });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns 400 and BAD_REQUEST when the confirmed action name is absent from CONFIRMABLE_ACTION_DEFINITIONS", async () => {
    mockConfirm.mockResolvedValue({ proposalId: 1, action: "nonexistent.action", payload: {} });
    const token = await signToken({ permissions: ["ai:chat:use"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/chat/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ token: STUB_TOKEN });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "BAD_REQUEST" });
  });

  it.each(DENY_CASES)(
    "returns 403 for $action when caller holds ai:chat:use but not $permission",
    async ({ action, payload }) => {
      mockConfirm.mockResolvedValue({ proposalId: 1, action, payload });
      const token = await signToken({ permissions: ["ai:chat:use"], enabledModules: ALL_MODULES });
      const res = await request(app.getHttpServer())
        .post("/chat/confirm")
        .set("Authorization", `Bearer ${token}`)
        .send({ token: STUB_TOKEN });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it("returns 201 with ok and executes ticket.create when caller holds ai:chat:use and build:tickets:create", async () => {
    mockConfirm.mockResolvedValue({
      proposalId: 1,
      action: "ticket.create",
      payload: { projectId: 1, title: "Test ticket", type: "TASK", priority: "MEDIUM" },
    });
    mockCreateTicket.mockResolvedValue({ id: 42, title: "Test ticket" });
    const token = await signToken({
      permissions: ["ai:chat:use", "build:tickets:create"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/chat/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ token: STUB_TOKEN });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, result: { ticketId: 42, title: "Test ticket" } });
    expect(mockMarkExecuted).toHaveBeenCalledWith(1, { ticketId: 42, title: "Test ticket" }, "org_1");
  });

  it("returns 201 with ok and executes chat.postChannel when caller holds ai:chat:use and chat:messages:write", async () => {
    mockConfirm.mockResolvedValue({
      proposalId: 2,
      action: "chat.postChannel",
      payload: { channelId: 1, message: "Hello team" },
    });
    mockChatSend.mockResolvedValue(undefined);
    const token = await signToken({
      permissions: ["ai:chat:use", "chat:messages:write"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/chat/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ token: STUB_TOKEN });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, result: { sent: true, channelId: 1 } });
    expect(mockMarkExecuted).toHaveBeenCalledWith(2, { sent: true, channelId: 1 }, "org_1");
  });

  it("returns 201 with ok and executes calendar.createReminder when caller holds ai:chat:use and calendar:write, using the provided timezone to avoid a DB lookup", async () => {
    mockConfirm.mockResolvedValue({
      proposalId: 3,
      action: "calendar.createReminder",
      payload: { title: "Stand-up", startDate: "2026-01-01", endDate: "2026-01-01", timezone: "UTC" },
    });
    mockCalendarCreateEvent.mockResolvedValue({ event: { id: 99 } });
    const token = await signToken({
      permissions: ["ai:chat:use", "calendar:write"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/chat/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ token: STUB_TOKEN });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, result: { eventId: 99 } });
    expect(mockMarkExecuted).toHaveBeenCalledWith(3, expect.objectContaining({ eventId: 99 }), "org_1");
  });

  it("returns 201 with ok and executes mail.send when caller holds ai:chat:use and mail:messages:send", async () => {
    mockConfirm.mockResolvedValue({
      proposalId: 4,
      action: "mail.send",
      payload: { accountId: 1, toEmail: "recipient@example.com", subject: "Hello", body: "World" },
    });
    mockMailAssertOwned.mockResolvedValue(undefined);
    mockMailSend.mockResolvedValue(undefined);
    const token = await signToken({
      permissions: ["ai:chat:use", "mail:messages:send"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/chat/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ token: STUB_TOKEN });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, result: { sent: true } });
    expect(mockMarkExecuted).toHaveBeenCalledWith(4, { sent: true }, "org_1");
  });
});
