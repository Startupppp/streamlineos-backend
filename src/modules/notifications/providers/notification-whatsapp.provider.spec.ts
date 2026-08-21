import { NotificationWhatsAppProvider } from "./notification-whatsapp.provider";
import type { ProviderSendInput } from "../notification.types";

/**
 * COMP-005. WHATSAPP used to resolve to the generic sandbox provider, which reports
 * SENT unconditionally — including for templates the provider would have rejected.
 * These tests exist so that the approval gate cannot be lost when a real transport is
 * wired in behind it.
 */
describe("NotificationWhatsAppProvider template approval gate", () => {
  function harness(template: Record<string, unknown> | undefined) {
    const limit = jest.fn().mockResolvedValue(template ? [template] : []);
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit }) }),
      }),
    };
    return new NotificationWhatsAppProvider(
      db as unknown as ConstructorParameters<typeof NotificationWhatsAppProvider>[0],
    );
  }

  const input: ProviderSendInput = {
    orgId: "org-a",
    userId: "user-1",
    channel: "WHATSAPP",
    title: "Payslip ready",
    message: "Your payslip is ready.",
    priority: "NORMAL",
    sandbox: true,
    metadata: { templateKey: "payslip.ready" },
  };

  it("sends when the template is approved and registered with the provider", async () => {
    const provider = harness({
      approvalStatus: "APPROVED",
      providerTemplateName: "payslip_ready_v3",
      rejectionReason: null,
    });

    const result = await provider.send(input);

    expect(result.status).toBe("SENT");
    expect(result.providerResponse).toMatchObject({ providerTemplateName: "payslip_ready_v3" });
  });

  it("refuses a pending template without contacting the provider", async () => {
    const provider = harness({
      approvalStatus: "PENDING",
      providerTemplateName: null,
      rejectionReason: null,
    });

    const result = await provider.send(input);

    expect(result.status).toBe("FAILED");
    expect(result.failureCode).toBe("TEMPLATE_PENDING");
    // Approval takes hours or days; retrying inside the queue's backoff cannot help and
    // would only burn the provider's rate limit and the account's standing.
    expect(result.retryable).toBe(false);
  });

  it("surfaces the provider's rejection reason so it is actionable", async () => {
    const provider = harness({
      approvalStatus: "REJECTED",
      providerTemplateName: null,
      rejectionReason: "Promotional content in a utility template",
    });

    const result = await provider.send(input);

    expect(result.status).toBe("FAILED");
    expect(result.failureCode).toBe("TEMPLATE_REJECTED");
    expect(result.failureMessage).toContain("Promotional content in a utility template");
  });

  it("fails when the notification declares no template at all", async () => {
    const provider = harness(undefined);

    const result = await provider.send({ ...input, metadata: {} });

    expect(result.status).toBe("FAILED");
    expect(result.failureCode).toBe("TEMPLATE_REQUIRED");
  });

  it("fails when the template does not exist for this organization", async () => {
    const provider = harness(undefined);

    const result = await provider.send(input);

    expect(result.status).toBe("FAILED");
    expect(result.failureCode).toBe("TEMPLATE_NOT_FOUND");
  });

  // Approved but never registered means there is no name to send under — reporting SENT
  // here would hide a misconfiguration behind a success.
  it("fails when an approved template has no provider template name", async () => {
    const provider = harness({
      approvalStatus: "APPROVED",
      providerTemplateName: null,
      rejectionReason: null,
    });

    const result = await provider.send(input);

    expect(result.status).toBe("FAILED");
    expect(result.failureCode).toBe("TEMPLATE_UNREGISTERED");
  });
});
