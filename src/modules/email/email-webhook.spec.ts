import { createHmac } from "crypto";
import { EmailWebhookService } from "./email-webhook.service";
import type { EmailSuppressionService } from "./email-suppression.service";

const SECRET_B64 = Buffer.from("test-signing-key").toString("base64");

function svixHeaders(rawBody: string, opts: { id?: string; timestampSecs?: number; secret?: string } = {}) {
  const id = opts.id ?? "msg_1";
  const timestamp = String(opts.timestampSecs ?? Math.floor(Date.now() / 1000));
  const key = Buffer.from((opts.secret ?? SECRET_B64).replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${sig}` };
}

describe("EmailWebhookService", () => {
  let suppress: jest.Mock;
  let service: EmailWebhookService;

  beforeEach(() => {
    process.env.RESEND_WEBHOOK_SECRET = `whsec_${SECRET_B64}`;
    suppress = jest.fn().mockResolvedValue(undefined);
    service = new EmailWebhookService({ suppress } as unknown as EmailSuppressionService);
  });

  afterEach(() => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    delete process.env.ZEPTOMAIL_WEBHOOK_SECRET;
  });

  const bounce = JSON.stringify({ type: "email.bounced", data: { to: ["gone@example.com"] } });

  it("suppresses a hard bounce when the signature is valid", async () => {
    const result = await service.handle({
      provider: "resend",
      rawBody: bounce,
      headers: svixHeaders(bounce),
    });
    expect(result.status).toBe(200);
    expect(result.body.suppressed).toBe(1);
    expect(suppress).toHaveBeenCalledWith(
      expect.objectContaining({ email: "gone@example.com", reason: "HARD_BOUNCE", orgId: null }),
    );
  });

  // An unauthenticated bounce webhook lets anyone suppress any address, which is a
  // targeted denial of mail. Every rejection path below must write nothing.
  it("rejects a request with no signature headers", async () => {
    const result = await service.handle({ provider: "resend", rawBody: bounce, headers: {} });
    expect(result.status).toBe(401);
    expect(suppress).not.toHaveBeenCalled();
  });

  it("rejects a forged signature", async () => {
    const headers = { ...svixHeaders(bounce), "svix-signature": "v1,not-a-real-signature" };
    const result = await service.handle({ provider: "resend", rawBody: bounce, headers });
    expect(result.status).toBe(401);
    expect(suppress).not.toHaveBeenCalled();
  });

  it("rejects a signature computed over a different body", async () => {
    const headers = svixHeaders(JSON.stringify({ type: "email.bounced", data: { to: ["other@x.io"] } }));
    const result = await service.handle({ provider: "resend", rawBody: bounce, headers });
    expect(result.status).toBe(401);
    expect(suppress).not.toHaveBeenCalled();
  });

  it("rejects a replayed request outside the timestamp window", async () => {
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const result = await service.handle({
      provider: "resend",
      rawBody: bounce,
      headers: svixHeaders(bounce, { timestampSecs: stale }),
    });
    expect(result.status).toBe(401);
    expect(suppress).not.toHaveBeenCalled();
  });

  it("fails closed when no signing secret is configured", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const result = await service.handle({
      provider: "resend",
      rawBody: bounce,
      headers: svixHeaders(bounce),
    });
    expect(result.status).toBe(401);
    expect(suppress).not.toHaveBeenCalled();
  });

  it("ignores delivery events that are not bounces or complaints", async () => {
    const delivered = JSON.stringify({ type: "email.delivered", data: { to: ["fine@example.com"] } });
    const result = await service.handle({
      provider: "resend",
      rawBody: delivered,
      headers: svixHeaders(delivered),
    });
    expect(result.status).toBe(200);
    expect(result.body.suppressed).toBe(0);
    expect(suppress).not.toHaveBeenCalled();
  });

  it("suppresses a complaint", async () => {
    const complaint = JSON.stringify({ type: "email.complained", data: { to: ["angry@example.com"] } });
    const result = await service.handle({
      provider: "resend",
      rawBody: complaint,
      headers: svixHeaders(complaint),
    });
    expect(suppress).toHaveBeenCalledWith(expect.objectContaining({ reason: "COMPLAINT" }));
    expect(result.body.suppressed).toBe(1);
  });

  it("rejects a zeptomail callback when the shared secret does not match", async () => {
    process.env.ZEPTOMAIL_WEBHOOK_SECRET = "correct-secret";
    const body = JSON.stringify({ event_name: "hardbounce", email: "gone@example.com" });
    const result = await service.handle({
      provider: "zeptomail",
      rawBody: body,
      headers: { "x-zeptomail-webhook-secret": "wrong-secret" },
    });
    expect(result.status).toBe(401);
    expect(suppress).not.toHaveBeenCalled();
  });

  it("accepts a zeptomail callback with the shared secret", async () => {
    process.env.ZEPTOMAIL_WEBHOOK_SECRET = "correct-secret";
    const body = JSON.stringify({ event_name: "hardbounce", email: "gone@example.com" });
    const result = await service.handle({
      provider: "zeptomail",
      rawBody: body,
      headers: { "x-zeptomail-webhook-secret": "correct-secret" },
    });
    expect(result.status).toBe(200);
    expect(suppress).toHaveBeenCalledWith(expect.objectContaining({ reason: "HARD_BOUNCE" }));
  });
});
