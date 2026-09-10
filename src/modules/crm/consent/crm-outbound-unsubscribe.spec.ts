import {
  CrmOutboundEmailService,
  contactUnsubscribe,
} from "./crm-outbound-email.service";
import type { CrmConsentService } from "./crm-consent.service";
import type { AutomationEmailService } from "../../automation/automation-email.service";
import { verifyUnsubscribeToken } from "./unsubscribe-token.util";

const API_ORIGIN = "https://api.example.test";
const APP_ORIGIN = "https://app.example.test";
const CONTACT_EMAIL = "lead@example.test";

/**
 * The two origins arrive through `APP_CONFIG`, not `process.env`.
 *
 * That is the point of the injection: jest hands every test file its own copy
 * of `process.env`, so a value set in a spec is invisible to anything that
 * reads it outside the module graph — and the old helpers read it on every
 * send. Passing config here means the test states the deployment it is
 * describing, in the test.
 */
function makeService(
  contactEmail: string | null = CONTACT_EMAIL,
  config: { APP_URL: string; PUBLIC_API_URL?: string } = {
    APP_URL: APP_ORIGIN,
    PUBLIC_API_URL: API_ORIGIN,
  },
) {
  const send = jest.fn().mockResolvedValue(undefined);
  const email = { send } as unknown as AutomationEmailService;
  const consent = {
    suppressedEmails: jest.fn().mockResolvedValue(new Set<string>()),
    contactEmail: jest.fn().mockResolvedValue(contactEmail),
  } as unknown as CrmConsentService;
  return {
    service: new CrmOutboundEmailService(
      email,
      consent,
      config as { APP_URL: string; PUBLIC_API_URL?: string },
    ),
    send,
    consent,
  };
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

/** The href a PERSON clicks, pulled out of the footer this service appends. */
function footerLinkFrom(send: jest.Mock): string {
  const match = /href="([^"]+)"/.exec(sentOptions(send).html);
  expect(match).not.toBeNull();
  return match![1]!;
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
  /* The token signer still reads its key from the environment. */
  const saved = { secret: process.env.ENCRYPTION_KEY };

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = "k".repeat(48);
  });

  afterAll(() => {
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

  /**
   * The two links serve two readers and must not be the same URL.
   *
   * The footer link used to point at the API alongside the header, so a person
   * who clicked "Unsubscribe" was opted out and shown the literal text
   * `{"success":true}` -- the endpoint answers JSON, because the other two verbs
   * on it are for mail clients. The opt-out worked and the recipient had no way
   * to know it, which is the one thing an unsubscribe must never leave in doubt.
   */
  it("points the person at a page and the mail client at the API", async () => {
    const { service, send } = makeService();
    await service.send("org-1", message, { contactId: 42, channel: "EMAIL" });

    const footer = footerLinkFrom(send);
    const header = linkFrom(send);

    expect(footer.startsWith(`${APP_ORIGIN}/unsubscribe/`)).toBe(true);
    expect(header.startsWith(`${API_ORIGIN}/crm/consent/unsubscribe/`)).toBe(true);
    expect(footer).not.toBe(header);

    /* One token, two addresses -- or the two links would opt out different people. */
    const footerToken = footer.slice(`${APP_ORIGIN}/unsubscribe/`.length);
    const headerToken = header.slice(`${API_ORIGIN}/crm/consent/unsubscribe/`.length);
    expect(footerToken).toBe(headerToken);
    expect(verifyUnsubscribeToken(footerToken)?.contactId).toBe(42);
  });

  /**
   * `PUBLIC_API_URL` is optional and `APP_URL` is required, so the halves fail
   * independently. This used to return `{}` -- no header AND no footer -- which
   * meant a deployment that had simply not set an optional variable sent
   * marketing mail with no opt-out at all. Omitting a native Unsubscribe button
   * is a degradation; omitting every way out is the defect the whole file exists
   * to close.
   */
  it("keeps the visible link when the API origin is unset, and drops only the header", async () => {
    const { service, send } = makeService(CONTACT_EMAIL, { APP_URL: APP_ORIGIN });
    await service.send("org-1", message, { contactId: 42, channel: "EMAIL" });

    expect(sentOptions(send).headers).toBeUndefined();
    expect(footerLinkFrom(send).startsWith(`${APP_ORIGIN}/unsubscribe/`)).toBe(true);
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
