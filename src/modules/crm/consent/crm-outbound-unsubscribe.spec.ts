import {
  CrmOutboundEmailService,
  contactUnsubscribe,
} from "./crm-outbound-email.service";
import type { CrmConsentService } from "./crm-consent.service";
import type { AutomationEmailService } from "../../automation/automation-email.service";
import { verifyUnsubscribeToken } from "./unsubscribe-token.util";

const API_ORIGIN = "https://api.example.test";
const CONTACT_EMAIL = "lead@example.test";

function makeService(contactEmail: string | null = CONTACT_EMAIL) {
  const send = jest.fn().mockResolvedValue(undefined);
  const email = { send } as unknown as AutomationEmailService;
  const consent = {
    suppressedEmails: jest.fn().mockResolvedValue(new Set<string>()),
    contactEmail: jest.fn().mockResolvedValue(contactEmail),
  } as unknown as CrmConsentService;
  return { service: new CrmOutboundEmailService(email, consent), send, consent };
}

function sentOptions(send: jest.Mock) {
  return send.mock.calls[0]![0] as {
    html: string;
    text?: string;
    headers?: Record<string, string>;
  };
}

function linkFrom(send: jest.Mock): string {
  const header = sentOptions(send).headers?.["List-Unsubscribe"];
  expect(header).toBeDefined();
  return header!.replace(/^<|>$/g, "");
}

const message = { to: CONTACT_EMAIL, subject: "Hello", html: "<p>Body</p>" };

/**
 * The way out that CRM marketing mail could not offer.
 *
 * `buildUnsubscribeToken` and the public route it feeds both shipped, and
 * NOTHING MINTED A TOKEN -- across the whole repository the only callers were
 * two specs. So every automation and sequence email went out with no opt-out
 * while the endpoint that would have honoured one waited for a token nobody
 * issued, and `suppressedEmails` enforced a decision the recipient had no way
 * to make.
 */
describe("CRM outbound mail carries a working opt-out", () => {
  const saved = { api: process.env.PUBLIC_API_URL, secret: process.env.ENCRYPTION_KEY };

  beforeEach(() => {
    process.env.PUBLIC_API_URL = API_ORIGIN;
    process.env.ENCRYPTION_KEY = "k".repeat(48);
  });

  afterAll(() => {
    process.env.PUBLIC_API_URL = saved.api;
    process.env.ENCRYPTION_KEY = saved.secret;
  });

  it("mints a token the public route can actually verify", async () => {
    const { service, send } = makeService();
    await service.send("org-1", message, { contactId: 42, channel: "EMAIL" });

    const url = linkFrom(send);
    expect(url.startsWith(`${API_ORIGIN}/crm/consent/unsubscribe/`)).toBe(true);

    /*
      Round-tripped through the real verifier rather than pattern-matched. A
      token that looks right and does not verify is the exact failure this
      whole path already had, one layer up.
    */
    const token = url.slice(`${API_ORIGIN}/crm/consent/unsubscribe/`.length);
    expect(verifyUnsubscribeToken(token)).toEqual({
      orgId: "org-1",
      contactId: 42,
      channel: "EMAIL",
    });
  });

  it("offers both the header and a visible link, because they serve different readers", async () => {
    const { service, send } = makeService();
    await service.send("org-1", { ...message, text: "Body" }, { contactId: 42, channel: "EMAIL" });

    const options = sentOptions(send);
    expect(options.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    /* The body is kept, not replaced. */
    expect(options.html).toContain("<p>Body</p>");
    expect(options.html).toContain("Unsubscribe");
    expect(options.text).toContain("Unsubscribe: ");
  });

  it("adds nothing at all when the caller names no contact", async () => {
    const { service, send } = makeService();
    await service.send("org-1", message);

    const options = sentOptions(send);
    expect(options.headers).toBeUndefined();
    expect(options.html).toBe("<p>Body</p>");
  });

  it("sends no link rather than a broken one when the API origin is unset", async () => {
    delete process.env.PUBLIC_API_URL;
    const { service, send } = makeService();
    await service.send("org-1", message, { contactId: 42, channel: "EMAIL" });
    expect(sentOptions(send).headers).toBeUndefined();
  });

  it("refuses to attach one contact's link to a message sent to several people", async () => {
    const { service, send } = makeService();
    await service.send(
      "org-1",
      { ...message, to: [CONTACT_EMAIL, "someone.else@example.test"] },
      { contactId: 42, channel: "EMAIL" },
    );
    /*
      Otherwise the second recipient holds a link that opts the first one out.
    */
    expect(sentOptions(send).headers).toBeUndefined();
  });

  it("refuses when the recipient is not the contact the token names", async () => {
    const { service, send } = makeService("someone.else@example.test");
    await service.send("org-1", message, { contactId: 42, channel: "EMAIL" });
    expect(sentOptions(send).headers).toBeUndefined();
  });

  it("matches the address case-insensitively, so a capitalised To still gets a link", async () => {
    const { service, send } = makeService("Lead@Example.Test");
    await service.send("org-1", message, { contactId: 42, channel: "EMAIL" });
    expect(sentOptions(send).headers?.["List-Unsubscribe"]).toBeDefined();
  });

  it("still sends nothing to a suppressed recipient", async () => {
    const { service, send, consent } = makeService();
    (consent.suppressedEmails as jest.Mock).mockResolvedValue(new Set([CONTACT_EMAIL]));

    const result = await service.send("org-1", message, { contactId: 42, channel: "EMAIL" });
    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: [], suppressed: [CONTACT_EMAIL] });
  });
});

/**
 * Which enrolled entities can be unsubscribed at all.
 *
 * Consent is a row against a contact and a channel, so a lead or a deal has
 * nothing to withdraw. `entityId` arrives as a string from the enrolment row.
 */
describe("choosing an unsubscribe subject", () => {
  it("takes a contact", () => {
    expect(contactUnsubscribe("contact", "42")).toEqual({ contactId: 42, channel: "EMAIL" });
    expect(contactUnsubscribe("CONTACT", " 42 ")).toEqual({ contactId: 42, channel: "EMAIL" });
  });

  it("refuses a lead or a deal", () => {
    expect(contactUnsubscribe("lead", "42")).toBeUndefined();
    expect(contactUnsubscribe("deal", "42")).toBeUndefined();
  });

  it("refuses an id that is not wholly digits", () => {
    /*
      The trap `parseInt` sets: it reads a leading numeric prefix and discards
      the rest, so a uuid beginning `4f0b...` would become contact 4 and mail
      that stranger's opt-out link to somebody else entirely.
    */
    expect(contactUnsubscribe("contact", "4f0b6a3e-9c2f-4a6f-8a11-0b5f0f4e1c22")).toBeUndefined();
    expect(contactUnsubscribe("contact", "")).toBeUndefined();
    expect(contactUnsubscribe("contact", "0")).toBeUndefined();
    expect(contactUnsubscribe("contact", "-5")).toBeUndefined();
  });
});
