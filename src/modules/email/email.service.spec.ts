import type { EmailOutboxService } from "./email-outbox.service";
import type { EmailProviderService } from "./email.provider";
import { EmailService } from "./email.service";

describe("EmailService", () => {
  it("durably queues an invitation and attempts delivery immediately", async () => {
    const enqueueAndTry = jest.fn().mockResolvedValue(undefined);
    const enqueueOnly = jest.fn().mockResolvedValue(undefined);
    const service = new EmailService(
      { enqueueAndTry, enqueueOnly } as unknown as EmailOutboxService,
      {} as EmailProviderService,
    );

    await service.queueInvitationEmail(
      "invitee@example.com",
      "token",
      "Acme",
    );

    expect(enqueueAndTry).toHaveBeenCalledTimes(1);
    expect(enqueueOnly).not.toHaveBeenCalled();
  });
});
