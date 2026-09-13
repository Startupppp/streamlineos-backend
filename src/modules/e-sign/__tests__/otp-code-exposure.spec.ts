import { SignNotificationsService } from "../sign-notifications.service";
import type { EmailSignService } from "../../email/email-sign.service";

const CODE = "483927";

/**
 * A one-time signing code must reach only the body.
 *
 * The subject and the preheader are the two parts of an email that render
 * without it being opened: on a locked phone, in a mail-client list view over
 * somebody's shoulder, and in the relay and archive logs that record headers far
 * more casually than content. This service put the code in both.
 *
 * That matters more than it would for a login code, because the envelope's own
 * invitation already arrived at this address. A second factor delivered to the
 * same inbox is thin to begin with; delivered to the same inbox's *preview* it
 * is not a factor at all.
 */
function capture() {
  const sent: { to: string; subject: string; html: string }[] = [];
  const email = {
    sendEmail: jest.fn(async (message: { to: string; subject: string; html: string }) => {
      sent.push(message);
    }),
  };
  return { sent, service: new SignNotificationsService(email as unknown as EmailSignService) };
}

describe("the one-time signing code", () => {
  it("never appears in the subject", async () => {
    const { sent, service } = capture();

    await service.sendOtpCode("signer@example.com", "Priya", CODE);

    expect(sent[0]?.subject).not.toContain(CODE);
  });

  it("never appears in the preheader, which is the preview text", async () => {
    const { sent, service } = capture();

    await service.sendOtpCode("signer@example.com", "Priya", CODE);

    /*
     * Targets the hidden preheader div the template emits, not a slice of the
     * document. My first version cut at the first occurrence of `email-text`,
     * which is a CSS class name declared in the <style> block near the top — so
     * the slice ended BEFORE the preheader and the assertion passed against the
     * exact markup it was written to reject. Caught by reverting the fix and
     * watching only one of the four cases fail.
     */
    const html = sent[0]?.html ?? "";
    const preheader = /<div style="display:none;[^"]*">([\s\S]*?)<\/div>/.exec(html);
    expect(preheader).not.toBeNull();
    expect(preheader?.[1] ?? "").not.toContain(CODE);
  });

  it("still delivers the code in the body, where it is actually needed", async () => {
    const { sent, service } = capture();

    await service.sendOtpCode("signer@example.com", "Priya", CODE);

    expect(sent[0]?.html).toContain(CODE);
  });

  it("goes to the address it was given", async () => {
    const { sent, service } = capture();

    await service.sendOtpCode("signer@example.com", "Priya", CODE);

    expect(sent[0]?.to).toBe("signer@example.com");
  });
});
