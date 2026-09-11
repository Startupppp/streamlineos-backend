import { ForbiddenException, type INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { ChatChannelMembersService } from "./chat-channel-members.service";
import { ChatMessagesService } from "./chat-messages.service";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";

/**
 * These replace the four Build-keyed action specs. The assertion that matters is
 * the third one: a caller holding no Build permission must not be refused for a
 * reference Build does not own, which is exactly what the old routes did.
 */

const DEAL = { type: "deal", id: "42" };

const members = {
  assertChannelMembership: jest.fn().mockResolvedValue(undefined),
};

const entities = {
  actionsFor: jest
    .fn()
    .mockResolvedValue([[{ id: "stage", label: "Change stage", inputs: [] }]]),
  submitAction: jest
    .fn()
    .mockResolvedValue({ ok: true, message: null, data: { stage: "WON" } }),
};

const messages = {
  sendSystemMessage: jest.fn().mockResolvedValue(undefined),
};

/*
  The action route carries `@Idempotent` now, and refuses a request without the
  header before it reaches the membership check, the permission check or the
  reference resolver — which is every decision these cases are about. A counter
  rather than a constant, so no two of them collide on one fence.
*/
let idempotencyKey = 0;

describe("Chat entity actions (e2e, no DB required)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: ChatChannelMembersService, useValue: members },
        { provide: EntityReferenceService, useValue: entities },
        { provide: ChatMessagesService, useValue: messages },
      ],
    });
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    members.assertChannelMembership.mockResolvedValue(undefined);
    entities.actionsFor.mockResolvedValue([
      [{ id: "stage", label: "Change stage", inputs: [] }],
    ]);
    entities.submitAction.mockResolvedValue({
      ok: true,
      message: null,
      data: { stage: "WON" },
    });
  });

  const routes: ReadonlyArray<string> = [
    "/chat/entity-actions/available",
    "/chat/entity-actions/submit",
  ];

  it.each(routes)("401 on POST %s without a token", async (path) => {
    const res = await request(app.getHttpServer()).post(path);
    expect(res.status).toBe(401);
  });

  it("403 when the caller is not a member of the conversation", async () => {
    members.assertChannelMembership.mockRejectedValue(
      new ForbiddenException("You are not a member of this channel"),
    );
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });

    const res = await request(app.getHttpServer())
      .post("/chat/entity-actions/submit")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `chat-entity-${String(idempotencyKey++)}`)
      .send({ channelId: 1, reference: DEAL, actionId: "stage", input: {} });

    expect(res.status).toBe(403);
  });

  it("does not refuse a non-Build reference for want of a Build permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });

    const res = await request(app.getHttpServer())
      .post("/chat/entity-actions/submit")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `chat-entity-${String(idempotencyKey++)}`)
      .send({ channelId: 1, reference: DEAL, actionId: "stage", input: {} });

    expect(res.status).toBe(201);
    expect(entities.submitAction).toHaveBeenCalledTimes(1);
  });

  it("leaves the refusal to the adapter that owns the record", async () => {
    entities.submitAction.mockResolvedValue({ ok: false, reason: "forbidden" });
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });

    const res = await request(app.getHttpServer())
      .post("/chat/entity-actions/submit")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `chat-entity-${String(idempotencyKey++)}`)
      .send({ channelId: 1, reference: DEAL, actionId: "stage", input: {} });

    expect(res.status).toBe(403);
  });

  it("reports a reference the seam cannot resolve as not found", async () => {
    entities.submitAction.mockResolvedValue({ ok: false, reason: "not-found" });
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });

    const res = await request(app.getHttpServer())
      .post("/chat/entity-actions/submit")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `chat-entity-${String(idempotencyKey++)}`)
      .send({ channelId: 1, reference: DEAL, actionId: "stage", input: {} });

    expect(res.status).toBe(404);
  });

  it("chat is platform core: a member with no enabled modules is still served", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });

    const res = await request(app.getHttpServer())
      .post("/chat/entity-actions/submit")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `chat-entity-${String(idempotencyKey++)}`)
      .send({ channelId: 1, reference: DEAL, actionId: "stage", input: {} });

    expect(res.status).toBe(201);
  });

  it("channel membership is still the real gate: no modules + non-member yields 403", async () => {
    members.assertChannelMembership.mockRejectedValue(
      new ForbiddenException("You are not a member of this channel"),
    );
    const token = await signToken({ permissions: [], enabledModules: [] });

    const res = await request(app.getHttpServer())
      .post("/chat/entity-actions/submit")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `chat-entity-${String(idempotencyKey++)}`)
      .send({ channelId: 1, reference: DEAL, actionId: "stage", input: {} });

    expect(res.status).toBe(403);
  });

  it("answers for a list of references in one call rather than one per reference", async () => {
    entities.actionsFor.mockResolvedValue([[], []]);
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });

    const res = await request(app.getHttpServer())
      .post("/chat/entity-actions/available")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `chat-entity-${String(idempotencyKey++)}`)
      .send({
        channelId: 1,
        references: [DEAL, { type: "ticket", id: "7" }],
      });

    expect(res.status).toBe(201);
    expect(entities.actionsFor).toHaveBeenCalledTimes(1);
    expect(res.body.references).toHaveLength(2);
  });

  it("pairs each reference with the actions the actor may take on it", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });

    const res = await request(app.getHttpServer())
      .post("/chat/entity-actions/available")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `chat-entity-${String(idempotencyKey++)}`)
      .send({ channelId: 1, references: [DEAL] });

    expect(res.body.references[0]).toMatchObject({
      reference: DEAL,
      actions: [{ id: "stage", label: "Change stage" }],
    });
  });

  it("rejects a body with no references", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });

    const res = await request(app.getHttpServer())
      .post("/chat/entity-actions/available")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `chat-entity-${String(idempotencyKey++)}`)
      .send({ channelId: 1, references: [] });

    expect(res.status).toBe(400);
  });
});
