import type { EmailOutboxService } from "./email-outbox.service";
import type { EmailProviderService } from "./email.provider";
import { EmailService } from "./email.service";

describe("EmailService", () => {
  function makeService() {
    const enqueueAndTry = jest.fn().mockResolvedValue(undefined);
    const enqueueOnly = jest.fn().mockResolvedValue(undefined);
    const service = new EmailService(
      { enqueueAndTry, enqueueOnly } as unknown as EmailOutboxService,
      {} as EmailProviderService,
    );
    return { service, enqueueAndTry, enqueueOnly };
  }

  it("queues an invitation through the enqueue-only path, so no provider call runs inside the caller's transaction", async () => {
    const { service, enqueueAndTry, enqueueOnly } = makeService();

    await service.queueInvitationEmail("invitee@example.com", "token", "Acme");

    expect(enqueueOnly).toHaveBeenCalledTimes(1);
    expect(enqueueAndTry).not.toHaveBeenCalled();
  });

  it("queues the invitation body the relay will send, addressed to the invitee", async () => {
    const { service, enqueueOnly } = makeService();

    await service.queueInvitationEmail("invitee@example.com", "tok-123", "Acme");

    const options: unknown = enqueueOnly.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      to: "invitee@example.com",
      subject: "You've been invited to join Acme",
    });
    expect(
      typeof options === "object" && options !== null && "html" in options
        ? String(options.html)
        : "",
    ).toContain("tok-123");
  });
});
