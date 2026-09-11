import { BadGatewayException } from "@nestjs/common";
import { ProviderCircuitBreaker } from "../../../common/outbound/provider-circuit-breaker";
import { RazorpayAdapter, type RazorpayTransport } from "./adapters/razorpay.adapter";
import { PaymentProviderAdapterRegistry } from "./payment-provider-adapter.interface";

describe("Razorpay order creation with an ambiguous outcome", () => {
  it("does not create another order when the provider commits then returns 500", async () => {
    const createdOrders: string[] = [];
    const transport: RazorpayTransport = async () => {
      createdOrders.push(`order_${createdOrders.length + 1}`);
      return Response.json({ error: { description: "response failed after commit" } }, { status: 500 });
    };
    const runtime = new RazorpayAdapter(new PaymentProviderAdapterRegistry(), {
      transport,
      breaker: new ProviderCircuitBreaker(),
      baseDelayMs: 1,
      maxDelayMs: 1,
    }).configure({ keyId: "rzp_test_local", secret: "local-test-secret" });

    await expect(runtime.createOrder({ amount: "10000", currency: "INR", receipt: "ambiguous-order" }))
      .rejects.toBeInstanceOf(BadGatewayException);
    expect(createdOrders).toEqual(["order_1"]);
  });
});
