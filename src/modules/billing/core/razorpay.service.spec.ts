import type { AppConfig } from "../../../config/env.validation";
import { RazorpayService } from "./razorpay.service";

const CONFIGURED = {
  RAZORPAY_KEY_ID: "rzp_test_public",
  RAZORPAY_KEY_SECRET: "private-secret",
  RAZORPAY_WEBHOOK_SECRET: "webhook-secret",
} as unknown as AppConfig;

describe("RazorpayService outbound safety", () => {
  afterEach(() => jest.restoreAllMocks());

  it("does not retry an ambiguous create because Razorpay has no verified idempotency key", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: { description: "possibly committed" } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      new RazorpayService(CONFIGURED).createOrder({
        amount: 1900,
        currency: "INR",
        receipt: "receipt-only-not-idempotency",
        notes: {},
      }),
    ).rejects.toMatchObject({ attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a read on a retryable provider failure", async () => {
    const order = {
      id: "order_1",
      amount: 1900,
      currency: "INR",
      status: "paid",
      notes: {},
    };
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => order });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(new RazorpayService(CONFIGURED).fetchOrder(order.id)).resolves.toEqual(order);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses provider calls before building credentials when unconfigured", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      new RazorpayService({} as AppConfig).createOrder({
        amount: 1900,
        currency: "INR",
        receipt: "receipt-1",
        notes: {},
      }),
    ).rejects.toThrow(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
