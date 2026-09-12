import { StripeWebhookController } from "./stripe-webhook.controller";
import type { StripePlatformWebhookService } from "./stripe-webhook.service";
import { paymentIntentSucceededEvent } from "./testing/stripe-webhook-fixtures";

/**
 * The HTTP seam, which has exactly two ways to be wrong.
 *
 * Stripe signs the BYTES it sent. Reading the parsed body and re-serialising it
 * produces a different string -- different key order, different whitespace --
 * and every delivery then fails verification for a reason that looks like a bad
 * secret. And the header is `stripe-signature`, not Razorpay's
 * `x-razorpay-signature`, so a copied controller silently verifies an empty
 * string against every body.
 */
describe("StripeWebhookController", () => {
  function makeResponse() {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    return { res: { status } as never, status, json };
  }

  it("passes the raw bytes and the stripe-signature header through untouched", async () => {
    const handle = jest.fn().mockResolvedValue({ status: 200, body: { ok: true } });
    const controller = new StripeWebhookController({
      handle,
    } as unknown as StripePlatformWebhookService);
    const body = paymentIntentSucceededEvent();
    const { res } = makeResponse();

    await controller.handle("org1", { rawBody: Buffer.from(body) } as never, "t=1,v1=abc", res);

    expect(handle).toHaveBeenCalledWith("org1", body, "t=1,v1=abc");
  });

  it("relays the handler's status and body verbatim, so Stripe's retry logic sees the truth", async () => {
    const handle = jest.fn().mockResolvedValue({ status: 401, body: { ok: false } });
    const controller = new StripeWebhookController({
      handle,
    } as unknown as StripePlatformWebhookService);
    const { res, status, json } = makeResponse();

    await controller.handle("org1", { rawBody: Buffer.from("{}") } as never, "sig", res);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ ok: false });
  });

  /**
   * A missing header must reach verification as an empty string rather than
   * `undefined`, which would throw inside the parser instead of returning 401.
   */
  it("substitutes an empty signature when the header is absent", async () => {
    const handle = jest.fn().mockResolvedValue({ status: 401, body: { ok: false } });
    const controller = new StripeWebhookController({
      handle,
    } as unknown as StripePlatformWebhookService);
    const { res } = makeResponse();

    await controller.handle("org1", { rawBody: Buffer.from("{}") } as never, undefined, res);

    expect(handle).toHaveBeenCalledWith("org1", "{}", "");
  });

  it("treats a body express never buffered as empty rather than crashing", async () => {
    const handle = jest.fn().mockResolvedValue({ status: 400, body: { ok: false } });
    const controller = new StripeWebhookController({
      handle,
    } as unknown as StripePlatformWebhookService);
    const { res } = makeResponse();

    await controller.handle("org1", {} as never, "sig", res);

    expect(handle).toHaveBeenCalledWith("org1", "", "sig");
  });
});
