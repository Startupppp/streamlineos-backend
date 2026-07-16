import { LeadNotificationAiService } from "./lead-notification-ai.service";
import type { AiGatewayService } from "../ai/gateway/ai-gateway.service";
import type { AiInvokeResult } from "../ai/gateway/ai-gateway.types";

const ORG = "org_1";

function makeGateway(text = "New HOT Lead|||Call immediately", ok = true) {
  const result: AiInvokeResult<string> = ok
    ? { ok: true, data: text, model: "gpt-4o-mini", latencyMs: 50, correlationId: "c-1", usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } }
    : { ok: false, kind: "provider_unavailable", message: "down", correlationId: "c-1" };
  return {
    invokeText: jest.fn().mockResolvedValue(result),
  } as unknown as jest.Mocked<Pick<AiGatewayService, "invokeText">>;
}

function buildService(gateway: ReturnType<typeof makeGateway>) {
  return new LeadNotificationAiService(gateway as unknown as AiGatewayService);
}

const INPUT = {
  event: "LEAD_ASSIGNED" as const,
  defaultTitle: "Lead Assigned",
  defaultMessage: "A lead was assigned to you",
  orgId: ORG,
  context: { leadName: "Rajesh Sharma", priority: "HOT" },
};

describe("LeadNotificationAiService", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns enriched result when gateway succeeds with TITLE|||MESSAGE format", async () => {
    const gateway = makeGateway("Smart Title|||Smart message body");
    const svc = buildService(gateway);

    const result = await svc.generateSmartNotification(INPUT);

    expect(result.enriched).toBe(true);
    expect(result.title).toBe("Smart Title");
    expect(result.message).toBe("Smart message body");
  });

  it("calls gateway with feature 'lead.smart-notification', tier 'fast', maxTokens 256", async () => {
    const gateway = makeGateway();
    const svc = buildService(gateway);

    await svc.generateSmartNotification(INPUT);

    expect(gateway.invokeText).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: "lead.smart-notification",
        tier: "fast",
        maxTokens: 256,
        actor: { orgId: ORG, userId: null },
      }),
    );
  });

  it("falls back to default without throwing when gateway returns not ok", async () => {
    const gateway = makeGateway("", false);
    const svc = buildService(gateway);

    const result = await svc.generateSmartNotification(INPUT);

    expect(result.enriched).toBe(false);
    expect(result.title).toBe(INPUT.defaultTitle);
    expect(result.message).toBe(INPUT.defaultMessage);
  });

  it("falls back to default without throwing when gateway throws", async () => {
    const gateway = makeGateway();
    (gateway.invokeText as jest.Mock).mockRejectedValue(new Error("network error"));
    const svc = buildService(gateway);

    const result = await svc.generateSmartNotification(INPUT);

    expect(result.enriched).toBe(false);
    expect(result.title).toBe(INPUT.defaultTitle);
  });

  it("falls back to default when response has no SEPARATOR", async () => {
    const gateway = makeGateway("No separator in this response");
    const svc = buildService(gateway);

    const result = await svc.generateSmartNotification(INPUT);

    expect(result.enriched).toBe(false);
  });

  it("falls back to default for unknown event type", async () => {
    const gateway = makeGateway();
    const svc = buildService(gateway);

    const result = await svc.generateSmartNotification({
      ...INPUT,
      event: "UNKNOWN_EVENT" as never,
    });

    expect(result.enriched).toBe(false);
    expect(gateway.invokeText).not.toHaveBeenCalled();
  });
});
