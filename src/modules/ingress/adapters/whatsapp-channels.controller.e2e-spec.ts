import type { INestApplication } from "@nestjs/common";
import { NotFoundException } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { WhatsAppChannelsService } from "./whatsapp-channels.service";

/**
 * Who may bind a business line, and what comes back when they do.
 *
 * The delivery endpoint is deliberately open, because a provider has no
 * session. This is the half that decides a number's traffic should become
 * customer records, so the whole point of the suite is that it is closed: a
 * caller with no token, or with every CRM key except this one, cannot reach it.
 */

const CHANNEL_ID = "wa-channel-1";
const APP_SECRET = "b".repeat(32);

const VALID = {
  businessPhoneNumberId: "109876543210987",
  businessNumber: "15550001111",
  appSecret: APP_SECRET,
};

describe("WhatsApp channel management (e2e)", () => {
  let app: INestApplication;
  let created: Record<string, unknown>[];

  beforeAll(async () => {
    const channels = {
      list: () =>
        Promise.resolve([
          {
            crmWhatsappChannelId: CHANNEL_ID,
            businessPhoneNumberId: VALID.businessPhoneNumberId,
            businessNumber: VALID.businessNumber,
            enabled: true,
            lastDeliveryAt: null,
            lastAcceptedAt: null,
            lastNote: null,
            createdAt: new Date("2026-09-09T00:00:00.000Z"),
          },
        ]),
      create: (_orgId: string, input: Record<string, unknown>) => {
        created.push(input);
        return Promise.resolve({
          crmWhatsappChannelId: CHANNEL_ID,
          businessPhoneNumberId: input["businessPhoneNumberId"],
          businessNumber: input["businessNumber"],
          enabled: true,
          verifyToken: "the-verify-token",
          appSecretHint: "****bbbb",
          callbackPath: `/crm/ingress/whatsapp/${CHANNEL_ID}`,
        });
      },
      rotate: (_orgId: string, id: string) => {
        if (id !== CHANNEL_ID) return Promise.reject(new NotFoundException("Channel not found"));
        return Promise.resolve({ crmWhatsappChannelId: id, verifyToken: "a-new-token" });
      },
      setEnabled: (_orgId: string, id: string, input: { enabled: boolean }) =>
        Promise.resolve({ crmWhatsappChannelId: id, enabled: input.enabled }),
      remove: (_orgId: string, id: string) =>
        Promise.resolve({ crmWhatsappChannelId: id, removed: true }),
    };

    app = await createE2eApp({
      overrides: [{ provide: WhatsAppChannelsService, useValue: channels }],
    });
  });

  beforeEach(() => {
    created = [];
  });

  afterAll(async () => {
    await app.close();
  });

  const asHolder = () =>
    signToken({ permissions: ["crm:ingress:submit"], enabledModules: ALL_MODULES });

  describe("the guard chain", () => {
    it("401s a caller with no token", async () => {
      const res = await request(app.getHttpServer()).get("/crm/ingress/whatsapp-channels");
      expect(res.status).toBe(401);
    });

    it("403s a caller without crm:ingress:submit", async () => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await request(app.getHttpServer())
        .get("/crm/ingress/whatsapp-channels")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    /**
     * Holding the keys to the records a channel produces is not the same as
     * being allowed to decide where records come from.
     */
    it("403s a holder of the activity keys alone", async () => {
      const token = await signToken({
        permissions: ["crm:activities:view", "crm:activities:manage"],
        enabledModules: ALL_MODULES,
      });
      const res = await request(app.getHttpServer())
        .post("/crm/ingress/whatsapp-channels")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", "whatsapp-channel-forbidden")
        .send(VALID);
      expect(res.status).toBe(403);
      expect(created).toEqual([]);
    });
  });

  describe("binding a line", () => {
    it("returns the verify token and the callback url, and no app secret", async () => {
      const token = await asHolder();

      const res = await request(app.getHttpServer())
        .post("/crm/ingress/whatsapp-channels")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", "whatsapp-channel-create-1")
        .send(VALID);

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        crmWhatsappChannelId: CHANNEL_ID,
        verifyToken: "the-verify-token",
        appSecretHint: "****bbbb",
        callbackPath: `/crm/ingress/whatsapp/${CHANNEL_ID}`,
      });
      expect(JSON.stringify(res.body)).not.toContain(APP_SECRET);
    });

    const malformed: ReadonlyArray<[string, Record<string, unknown>]> = [
      ["a phone number id that is not the provider's numeric handle", {
        ...VALID,
        businessPhoneNumberId: "not-an-id",
      }],
      ["no app secret", { ...VALID, appSecret: "" }],
      ["an app secret short enough to be the wrong paste", { ...VALID, appSecret: "short" }],
      ["a provider access token smuggled alongside", { ...VALID, accessToken: "EAAG..." }],
      ["an organisation named by the caller", { ...VALID, organizationId: "org-2" }],
    ];

    it.each(malformed)("400s on %s", async (_case, body) => {
      const token = await asHolder();

      const res = await request(app.getHttpServer())
        .post("/crm/ingress/whatsapp-channels")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", `whatsapp-channel-bad-${_case.length}`)
        .send(body);

      expect(res.status).toBe(400);
      expect(created).toEqual([]);
    });
  });

  describe("the rest of the surface", () => {
    it("lists lines with the honesty fields and no secrets", async () => {
      const token = await asHolder();

      const res = await request(app.getHttpServer())
        .get("/crm/ingress/whatsapp-channels")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body[0]).toHaveProperty("lastNote");
      expect(res.body[0]).not.toHaveProperty("appSecret");
      expect(res.body[0]).not.toHaveProperty("verifyToken");
    });

    it("rotates to a new verify token", async () => {
      const token = await asHolder();

      const res = await request(app.getHttpServer())
        .post(`/crm/ingress/whatsapp-channels/${CHANNEL_ID}/rotate`)
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ verifyToken: "a-new-token" });
    });

    /** A channel in another tenant is a channel that does not exist. */
    it("404s rather than 403s for an id this organisation does not hold", async () => {
      const token = await asHolder();

      const res = await request(app.getHttpServer())
        .post("/crm/ingress/whatsapp-channels/somebody-elses-channel/rotate")
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(404);
    });

    it("stops the feed without giving the line up", async () => {
      const token = await asHolder();

      const res = await request(app.getHttpServer())
        .patch(`/crm/ingress/whatsapp-channels/${CHANNEL_ID}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ enabled: false });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ enabled: false });
    });

    it("400s a patch that tries to say anything else", async () => {
      const token = await asHolder();

      const res = await request(app.getHttpServer())
        .patch(`/crm/ingress/whatsapp-channels/${CHANNEL_ID}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ enabled: false, appSecret: "c".repeat(32) });

      expect(res.status).toBe(400);
    });

    it("gives the line up", async () => {
      const token = await asHolder();

      const res = await request(app.getHttpServer())
        .delete(`/crm/ingress/whatsapp-channels/${CHANNEL_ID}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ removed: true });
    });
  });
});
