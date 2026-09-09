import {
  PreconditionFailedException,
  ServiceUnavailableException,
  type INestApplication,
} from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { ChatHuddlesService } from "./chat-huddles.service";
import { ChatHuddleSignalsService } from "./chat-huddle-signals.service";
import {
  HUDDLE_MEETING_NO_CONNECTION,
  HUDDLE_MEETING_PROVIDER_FAILED,
} from "./chat-huddle-meeting";

/**
 * The mesh routes are gone, and gone means unroutable — not merely unused.
 *
 * A handler left mapped keeps its guard chain, its rate-limit tier and its write; the browser
 * simply stops calling it. `chat-actions.controller.e2e-spec.ts` pins its retired routes the
 * same way, because a route that answers anything but 404 is a route that still exists.
 */

const huddles = {
  startHuddle: jest.fn().mockResolvedValue({
    id: 1,
    channelId: 1,
    status: "active",
    calendarEventId: null,
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    startedAt: new Date(),
    endedAt: null,
    startedBy: null,
    startedByUser: null,
    participants: [],
  }),
  getActiveHuddle: jest.fn().mockResolvedValue(null),
  joinHuddle: jest.fn().mockResolvedValue({ ok: true }),
  leaveHuddle: jest.fn().mockResolvedValue({ ok: true }),
  kickParticipant: jest.fn().mockResolvedValue({ ok: true }),
  inviteToHuddle: jest.fn().mockResolvedValue({ ok: true }),
};

const signals = {
  heartbeat: jest.fn().mockResolvedValue({ ok: true }),
};

describe("ChatHuddles routes after the Google Meet cutover (e2e, no DB required)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: ChatHuddlesService, useValue: huddles },
        { provide: ChatHuddleSignalsService, useValue: signals },
      ],
    });
  });

  afterAll(async () => app.close());

  beforeEach(() => jest.clearAllMocks());

  const retiredPatch: ReadonlyArray<string> = [
    "/chat/huddles/1/mute",
    "/chat/huddles/1/hand",
    "/chat/huddles/1/deafen",
    "/chat/huddles/1/screenshare",
  ];

  it.each(retiredPatch)("404 on the retired route PATCH %s", async (path) => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });

    const res = await request(app.getHttpServer())
      .patch(path)
      .set("Authorization", `Bearer ${token}`)
      .send({ muted: true, raised: true, deafened: true, isScreenSharing: true });

    expect(res.status).toBe(404);
  });

  it("404 on the retired route POST /chat/huddles/:huddleId/signal", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });

    const res = await request(app.getHttpServer())
      .post("/chat/huddles/1/signal")
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "offer", targetUserId: "user-2", payload: {} });

    expect(res.status).toBe(404);
  });

  it("404 on the retired route GET /realtime/ice-servers", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });

    const res = await request(app.getHttpServer())
      .get("/realtime/ice-servers")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  /**
   * The control. Without it the 404s above pass just as happily against a suite whose
   * application failed to map the chat huddle controller at all.
   */
  it("CONTROL: the kept routes are still mapped and still gated", async () => {
    const kept: ReadonlyArray<[string, string]> = [
      ["post", "/chat/channels/1/huddle/start"],
      ["get", "/chat/channels/1/huddle"],
      ["post", "/chat/huddles/1/join"],
      ["post", "/chat/huddles/1/leave"],
      ["post", "/chat/huddles/1/kick"],
      ["post", "/chat/huddles/1/invite"],
      ["patch", "/chat/huddles/1/heartbeat"],
    ];

    for (const [method, path] of kept) {
      const res = await request(app.getHttpServer())[method === "get" ? "get" : method === "patch" ? "patch" : "post"](path);
      expect([method, path, res.status]).toEqual([method, path, 401]);
    }
  });

  it("returns the Meet link in the start response, which is the only way into the call", async () => {
    const token = await signToken({
      permissions: ["chat:huddles:start"],
      enabledModules: ALL_MODULES,
    });

    const res = await request(app.getHttpServer())
      .post("/chat/channels/1/huddle/start")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(201);
    expect(res.body?.data?.meetingUrl ?? res.body?.meetingUrl).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
  });

  /**
   * The status the browser actually receives, which is the half the unit specs cannot see:
   * `AllExceptionsFilter` re-shapes every thrown error into one envelope, and a filter that
   * flattened these to 500 — or to each other — would leave the frontend unable to tell
   * "connect Google" from "try again" while both unit specs still passed.
   */
  it("a missing Google connection reaches the client as 412, not 500 and not 503", async () => {
    huddles.startHuddle.mockRejectedValueOnce(
      new PreconditionFailedException(HUDDLE_MEETING_NO_CONNECTION),
    );
    const token = await signToken({
      permissions: ["chat:huddles:start"],
      enabledModules: ALL_MODULES,
    });

    const res = await request(app.getHttpServer())
      .post("/chat/channels/1/huddle/start")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(412);
    expect(JSON.stringify(res.body)).toContain("Settings");
  });

  it("a refusal from Google reaches the client as 503, so the affordance stays 'try again'", async () => {
    huddles.startHuddle.mockRejectedValueOnce(
      new ServiceUnavailableException(HUDDLE_MEETING_PROVIDER_FAILED),
    );
    const token = await signToken({
      permissions: ["chat:huddles:start"],
      enabledModules: ALL_MODULES,
    });

    const res = await request(app.getHttpServer())
      .post("/chat/channels/1/huddle/start")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(503);
  });
});
