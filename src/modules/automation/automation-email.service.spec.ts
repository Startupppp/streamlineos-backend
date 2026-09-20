import { AutomationEmailService } from "./automation-email.service";
import type { Provider } from "../email/email-provider-selection";

function build(provider: Provider): {
  service: AutomationEmailService;
  enqueueAndTry: jest.Mock;
} {
  const enqueueAndTry = jest.fn().mockResolvedValue(undefined);
  const service = new AutomationEmailService(
    { getEmailProvider: () => provider },
    { enqueueAndTry },
  );
  return { service, enqueueAndTry };
}

describe("AutomationEmailService", () => {
  it("routes automation mail through the outbox, so a provider failure is retried by the drain instead of lost", async () => {
    const { service, enqueueAndTry } = build("zeptomail");

    await service.send({
      to: "lead@example.com",
      subject: "Deal moved to Won",
      html: "<p>congratulations</p>",
    });

    expect(enqueueAndTry).toHaveBeenCalledTimes(1);
    expect(enqueueAndTry).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Deal moved to Won" }),
    );
  });

  it("carries unsubscribe headers through to the outbox, because CRM marketing mail must keep its List-Unsubscribe", async () => {
    const { service, enqueueAndTry } = build("zeptomail");
    const headers = { "List-Unsubscribe": "<https://example.com/u/7>" };

    await service.send({ to: "c@example.com", subject: "s", html: "h", headers });

    expect(enqueueAndTry).toHaveBeenCalledWith(expect.objectContaining({ headers }));
  });

  it("enqueues nothing when no provider is configured, because the outbox would mark the row FAILED and throw into the automation run", async () => {
    const { service, enqueueAndTry } = build("none");

    await service.send({ to: "a@example.com", subject: "s", html: "h" });

    expect(enqueueAndTry).not.toHaveBeenCalled();
  });
});
