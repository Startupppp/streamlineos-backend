import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { InboundIngressService } from "../inbound-ingress.service";
import type { InboundCommunicationEvent } from "../inbound-event";
import { WhatsAppChannelsService } from "./whatsapp-channels.service";
import { signPayload } from "./mailbox-push";
import {
  deliveryBlock,
  FIXTURE_APP_SECRET,
  FIXTURE_BUSINESS_NUMBER,
  FIXTURE_PHONE_NUMBER_ID,
  statusReceipt,
  textMessage,
  webhookBody,
} from "./whatsapp-webhook.fixture";

/**
 * The channel, over HTTP.
 *
 * Everything below the controller already has unit coverage from the same
 * fixture, so what this file is for is the three things only a real request can
 * say: that the bytes the signature covers survive the framework, that a
 * refusal is a refusal rather than a quiet 200, and that the counts an operator
 * reads come back off the wire.
 *
 * The seam and the channel lookup are substituted at their own interfaces. The
 * adapter, the signature check, the body parsing and the status codes are the
 * real ones — those are the subject.
 */

const CHANNEL_ID = "wa-channel-1";
const ORG_ID = "org_1";

const binding = {
  organizationId: ORG_ID,
  businessPhoneNumberId: FIXTURE_PHONE_NUMBER_ID,
  businessNumber: FIXTURE_BUSINESS_NUMBER,
  appSecret: FIXTURE_APP_SECRET,
};

const channel = { crmWhatsappChannelId: CHANNEL_ID, binding, verifyToken: "verify-me-please" };

/** Signs the exact bytes that will be sent, which is the only thing that works. */
function sign(rawBody: string, secret: string = FIXTURE_APP_SECRET): string {
  return `sha256=${signPayload(secret, rawBody)}`;
}

describe("WhatsApp ingress (e2e)", () => {
  let app: INestApplication;
  let filed: InboundCommunicationEvent[];
  let seamAnswers: (Error | null)[];
  let recorded: { channelId: string; note: string | null; delivered: boolean }[];

  beforeAll(async () => {
    const channels = {
      resolveByChannelId: (id: string) =>
        Promise.resolve(id === CHANNEL_ID ? channel : null),
      resolveByPhoneNumberId: (line: string) =>
        Promise.resolve(line === FIXTURE_PHONE_NUMBER_ID ? channel : null),
      recordDelivery: (
        resolved: { crmWhatsappChannelId: string },
        outcome: { accepted: boolean; delivered?: number; note?: string | null; reason?: string },
      ) => {
        recorded.push({
          channelId: resolved.crmWhatsappChannelId,
          note: outcome.accepted ? outcome.note ?? null : `delivery refused: ${outcome.reason}`,
          delivered: outcome.accepted && (outcome.delivered ?? 0) > 0,
        });
        return Promise.resolve();
      },
    };

    const seam = {
      accept: (event: InboundCommunicationEvent) => {
        filed.push(event);
        const answer = seamAnswers.shift() ?? null;
        if (answer) return Promise.reject(answer);
        return Promise.resolve({
          status: "accepted" as const,
          inboundEventId: `receipt-${filed.length}`,
          workflowRunId: "run-1",
        });
      },
    };

    app = await createE2eApp({
      rawBody: true,
      overrides: [
        { provide: WhatsAppChannelsService, useValue: channels },
        { provide: InboundIngressService, useValue: seam },
      ],
    });
  });

  beforeEach(() => {
    filed = [];
    seamAnswers = [];
    recorded = [];
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (path: string, rawBody: string, signature?: string) => {
    const req = request(app.getHttpServer()).post(path).set("Content-Type", "application/json");
    return signature ? req.set("x-hub-signature-256", signature).send(rawBody) : req.send(rawBody);
  };

  describe("a delivery on the shared callback url", () => {
    it("files a signed message and answers with what became of it", async () => {
      const raw = JSON.stringify(webhookBody());

      const res = await post("/crm/ingress/whatsapp", raw, sign(raw));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        received: 1,
        delivered: 1,
        duplicate: 0,
        foreign: 0,
        note: null,
      });
      expect(filed).toHaveLength(1);
      expect(filed[0]).toMatchObject({ organizationId: ORG_ID, provider: "whatsapp" });
    });

    /**
     * The point of taking the raw body rather than `@Body()`.
     *
     * These bytes have whitespace no `JSON.stringify` would produce, so a
     * handler that re-serialised the parsed object would compute a different
     * digest and reject this — which is exactly the delivery a real provider
     * sends. Nothing else in the suite would catch that.
     */
    it("verifies the bytes as received, not a re-serialisation of them", async () => {
      const raw = JSON.stringify(webhookBody(), null, 2);

      const res = await post("/crm/ingress/whatsapp", raw, sign(raw));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ received: 1, delivered: 1 });
    });
  });

  describe("a delivery on a tenant's own callback url", () => {
    it("files it against the channel in the path", async () => {
      const raw = JSON.stringify(webhookBody());

      const res = await post(`/crm/ingress/whatsapp/${CHANNEL_ID}`, raw, sign(raw));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ received: 1, delivered: 1 });
      expect(recorded).toEqual([{ channelId: CHANNEL_ID, note: null, delivered: true }]);
    });
  });

  describe("refusals", () => {
    /** The acceptance criterion: a signature that does not check files nothing. */
    it("401s a tampered signature and writes nothing", async () => {
      const raw = JSON.stringify(webhookBody());
      const tampered = sign(raw).replace(/.$/, (c) => (c === "a" ? "b" : "a"));

      const res = await post("/crm/ingress/whatsapp", raw, tampered);

      expect(res.status).toBe(401);
      expect(filed).toEqual([]);
      expect(recorded).toEqual([
        { channelId: CHANNEL_ID, note: "delivery refused: bad-signature", delivered: false },
      ]);
    });

    it("401s a body signed with somebody else's secret", async () => {
      const raw = JSON.stringify(webhookBody());

      const res = await post("/crm/ingress/whatsapp", raw, sign(raw, "not-the-app-secret"));

      expect(res.status).toBe(401);
      expect(filed).toEqual([]);
    });

    it("401s a delivery carrying no signature at all", async () => {
      const raw = JSON.stringify(webhookBody());

      const res = await post("/crm/ingress/whatsapp", raw);

      expect(res.status).toBe(401);
      expect(filed).toEqual([]);
    });

    /**
     * An unknown line answers exactly as a bad signature does, on purpose.
     * Telling them apart turns the endpoint into a lookup service for which
     * business lines this deployment ingests.
     */
    it("answers an unknown business line the same way it answers a forgery", async () => {
      const raw = JSON.stringify(
        webhookBody([deliveryBlock({ messages: [textMessage()], phoneNumberId: "999" })]),
      );
      const unknown = await post("/crm/ingress/whatsapp", raw, sign(raw));

      const forged = JSON.stringify(webhookBody());
      const forgery = await post("/crm/ingress/whatsapp", forged, sign(forged, "wrong"));

      expect(unknown.status).toBe(401);
      expect(unknown.status).toBe(forgery.status);
      expect(unknown.body).toEqual(forgery.body);
      expect(filed).toEqual([]);
    });

    it("401s an unknown channel id", async () => {
      const raw = JSON.stringify(webhookBody());

      const res = await post("/crm/ingress/whatsapp/not-a-channel", raw, sign(raw));

      expect(res.status).toBe(401);
      expect(filed).toEqual([]);
    });
  });

  describe("honesty about what a delivery came to", () => {
    /**
     * A verified delivery for a line that is not this channel's. It files
     * nothing, and the whole point is that it says so rather than reporting a
     * healthy 200 with silence behind it.
     */
    it("names the reason when a signed delivery is for another line", async () => {
      const raw = JSON.stringify(
        webhookBody([deliveryBlock({ messages: [textMessage()], phoneNumberId: "111" })]),
      );

      const res = await post(`/crm/ingress/whatsapp/${CHANNEL_ID}`, raw, sign(raw));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ received: 0, delivered: 0, foreign: 1 });
      expect(res.body.note).toContain("different business line");
      expect(filed).toEqual([]);
    });

    it("counts read receipts as ignored rather than as messages", async () => {
      const raw = JSON.stringify(webhookBody([deliveryBlock({ statuses: [statusReceipt()] })]));

      const res = await post(`/crm/ingress/whatsapp/${CHANNEL_ID}`, raw, sign(raw));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ received: 0, delivered: 0, ignored: 1, note: null });
      expect(filed).toEqual([]);
    });

    /**
     * The one case worth a retry. The message that landed is deduplicated on
     * the provider's own id, so re-delivery is free; a 200 here loses the other
     * one for good.
     */
    it("503s when some of a delivery reached the seam and some did not", async () => {
      seamAnswers = [null, new Error("the seam fell over")];
      const raw = JSON.stringify(
        webhookBody([
          deliveryBlock({
            messages: [textMessage(), textMessage({ id: "wamid.second", text: { body: "and" } })],
          }),
        ]),
      );

      const res = await post(`/crm/ingress/whatsapp/${CHANNEL_ID}`, raw, sign(raw));

      expect(res.status).toBe(503);
      expect(filed).toHaveLength(2);
    });
  });

  describe("the subscription handshake", () => {
    const handshake = (over: Record<string, string> = {}, id: string = CHANNEL_ID) =>
      request(app.getHttpServer())
        .get(`/crm/ingress/whatsapp/${id}`)
        .query({
          "hub.mode": "subscribe",
          "hub.verify_token": "verify-me-please",
          "hub.challenge": "1158201444",
          ...over,
        });

    it("echoes the challenge back as bare text", async () => {
      const res = await handshake();

      expect(res.status).toBe(200);
      expect(res.text).toBe("1158201444");
    });

    it("403s a wrong verify token", async () => {
      const res = await handshake({ "hub.verify_token": "verify-me-pleasf" });

      expect(res.status).toBe(403);
      expect(res.text).toBe("");
    });

    it("403s a token of a different length", async () => {
      const res = await handshake({ "hub.verify_token": "short" });

      expect(res.status).toBe(403);
    });

    it("403s a mode other than subscribe", async () => {
      const res = await handshake({ "hub.mode": "unsubscribe" });

      expect(res.status).toBe(403);
    });

    it("403s an unknown channel", async () => {
      const res = await handshake({}, "not-a-channel");

      expect(res.status).toBe(403);
    });
  });
});
