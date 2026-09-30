import { ForbiddenException, type INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { ChatChannelMembersImplementation } from "./chat-channel-members-implementation";
import { ChatMessagesService } from "./chat-messages.service";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";

/**
 * Only one route remains here. Status, assign and due date moved to
 * `/chat/entity-actions/*`, and their guard-tier assertions moved with them
 * rather than being deleted — see `chat-entity-actions.controller.e2e-spec.ts`,
 * which additionally asserts the thing this route family used to get wrong: a
 * caller must not be refused for want of a Build permission on a record Build
 * does not own.
 */

const members = {
  assertChannelMembership: jest.fn().mockResolvedValue(undefined),
};

const messages = {
  readMessageContent: jest.fn().mockResolvedValue("the original message"),
  sendSystemMessage: jest.fn().mockResolvedValue(undefined),
  attachEntity: jest.fn().mockResolvedValue(undefined),
};

const entities = {
  submitAction: jest.fn().mockResolvedValue({
    ok: true,
    message: null,
    data: { ticketId: 5, ticketNumber: 11 },
  }),
};

const BODY = { channelId: 1, messageId: 2, projectId: 3, type: "TASK" };

describe("ChatActions auth (e2e, no DB required)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: ChatChannelMembersImplementation, useValue: members },
        { provide: ChatMessagesService, useValue: messages },
        { provide: EntityReferenceService, useValue: entities },
      ],
    });
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    members.assertChannelMembership.mockResolvedValue(undefined);
    messages.readMessageContent.mockResolvedValue("the original message");
    entities.submitAction.mockResolvedValue({
      ok: true,
      message: null,
      data: { ticketId: 5, ticketNumber: 11 },
    });
  });

  it("401 without a token", async () => {
    const res = await request(app.getHttpServer()).post(
      "/chat/actions/create-task-from-message",
    );
    expect(res.status).toBe(401);
  });

  it("403 when the caller is not a member of the conversation", async () => {
    members.assertChannelMembership.mockRejectedValue(
      new ForbiddenException("You are not a member of this channel"),
    );
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });

    const res = await request(app.getHttpServer())
      .post("/chat/actions/create-task-from-message")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "test-key-not-a-member-403")
      .send(BODY);

    expect(res.status).toBe(403);
  });

  it("400 when Idempotency-Key is missing on a mutating request", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });

    const res = await request(app.getHttpServer())
      .post("/chat/actions/create-task-from-message")
      .set("Authorization", `Bearer ${token}`)
      .send(BODY);

    expect(res.status).toBe(400);
  });

  it("chat is platform core: a member with no enabled modules is still served", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });

    const res = await request(app.getHttpServer())
      .post("/chat/actions/create-task-from-message")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "test-key-no-modules-201")
      .send(BODY);

    expect(res.status).toBe(201);
  });

  it("leaves the create refusal to the adapter that owns the record", async () => {
    entities.submitAction.mockResolvedValue({ ok: false, reason: "forbidden" });
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });

    const res = await request(app.getHttpServer())
      .post("/chat/actions/create-task-from-message")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "test-key-adapter-refusal-403")
      .send(BODY);

    expect(res.status).toBe(403);
  });

  it("refuses when the message cannot be read by this caller", async () => {
    messages.readMessageContent.mockResolvedValue(null);
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });

    const res = await request(app.getHttpServer())
      .post("/chat/actions/create-task-from-message")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "test-key-unreadable-message-403")
      .send(BODY);

    expect(res.status).toBe(403);
  });

  it("passes the message text through as the new record's description", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });

    await request(app.getHttpServer())
      .post("/chat/actions/create-task-from-message")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "test-key-passes-description")
      .send(BODY);

    expect(entities.submitAction).toHaveBeenCalledWith(
      expect.anything(),
      { type: "project", id: "3" },
      "create-ticket",
      expect.objectContaining({ description: "the original message" }),
    );
  });

  it("records the new ticket on the source message and the message on the ticket", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });

    const res = await request(app.getHttpServer())
      .post("/chat/actions/create-task-from-message")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "test-key-records-backlinks")
      .send(BODY);

    expect(res.status).toBe(201);
    expect(entities.submitAction).toHaveBeenCalledWith(
      expect.anything(),
      { type: "project", id: "3" },
      "create-ticket",
      expect.objectContaining({ sourceChannelId: 1, sourceMessageId: 2 }),
    );
    expect(messages.attachEntity).toHaveBeenCalledWith(2, 1, expect.any(String), {
      type: "ticket",
      id: "5",
    });
  });

  const retired: ReadonlyArray<string> = [
    "/chat/actions/ticket-status",
    "/chat/actions/assign-ticket",
    "/chat/actions/set-due-date",
  ];

  it.each(retired)("404 on the retired route %s", async (path) => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });

    const res = await request(app.getHttpServer())
      .post(path)
      .set("Authorization", `Bearer ${token}`)
      .send({ channelId: 1 });

    expect(res.status).toBe(404);
  });
});
