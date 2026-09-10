import { NotificationEmailProvider } from "./notification-email.provider";
import type { EmailProviderService } from "../../email/email.provider";
import type { ProviderSendInput } from "../notification.types";

const API_ORIGIN = "https://api.example.test";

function input(overrides: Partial<ProviderSendInput> = {}): ProviderSendInput {
  return {
    orgId: "org-1",
    userId: "user-1",
    channel: "EMAIL",
    recipientAddress: "someone@example.test",
    title: "A digest you did not ask for",
    message: "Weekly summary",
    priority: "NORMAL",
    sandbox: false,
    ...overrides,
  };
}

function makeProvider() {
  const dispatchEmail = jest.fn().mockResolvedValue(undefined);
  const emailProvider = {
    dispatchEmail,
    getEmailProvider: () => "resend",
  } as unknown as EmailProviderService;
  return { provider: new NotificationEmailProvider(emailProvider), dispatchEmail };
}

function headersOf(dispatchEmail: jest.Mock): Record<string, string> | undefined {
  const [options] = dispatchEmail.mock.calls[0] as [{ headers?: Record<string, string> }];
  return options.headers;
}

/**
 * RFC 8058 one-click unsubscribe, which was pointed at a host that cannot serve it.
 *
 * `UnsubscribeController` lives on THIS API at `notifications/unsubscribe/:token`,
 * and the header was built from `appUrl()` — the WEB APP origin, per its own
 * comment and every other caller. The web app has no route at that path and no
 * rewrite to the API, so the header on every non-mandatory notification email
 * named a 404. A `List-Unsubscribe` that fails is what a mailbox provider tests
 * a bulk sender on, so it is worse than sending none.
 */
describe("one-click unsubscribe headers", () => {
  const saved = { secret: process.env.UNSUBSCRIBE_TOKEN_SECRET, api: process.env.PUBLIC_API_URL };

  beforeEach(() => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = "a".repeat(48);
    process.env.PUBLIC_API_URL = API_ORIGIN;
  });

  afterAll(() => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = saved.secret;
    process.env.PUBLIC_API_URL = saved.api;
  });

  it("points at the API, which is the only host that answers that path", async () => {
    const { provider, dispatchEmail } = makeProvider();
    await provider.send(input());

    const headers = headersOf(dispatchEmail);
    expect(headers?.["List-Unsubscribe"]).toBeDefined();

    const url = headers!["List-Unsubscribe"]!.replace(/^<|>$/g, "");
    expect(url.startsWith(`${API_ORIGIN}/notifications/unsubscribe/`)).toBe(true);

    /*
      The assertion that would have caught the original bug. APP_URL is set in
      this suite's setup to the web app origin, and the old code built the URL
      from it; nothing else about the header changed, so only the host does.
    */
    expect(url.startsWith(process.env.APP_URL ?? "http://unset.invalid")).toBe(false);
  });

  it("sends no header at all when the API origin is not configured", async () => {
    delete process.env.PUBLIC_API_URL;
    const { provider, dispatchEmail } = makeProvider();
    await provider.send(input());

    /*
      Omission, not a fallback. An absent opt-out is a smaller failure than one
      the recipient clicks and lands nowhere, and it is the same rule the file
      already applies to mandatory mail.
    */
    expect(headersOf(dispatchEmail)).toBeUndefined();
  });

  it("still refuses to advertise an opt-out on mandatory mail", async () => {
    const { provider, dispatchEmail } = makeProvider();
    await provider.send(input({ mandatory: true }));
    expect(headersOf(dispatchEmail)).toBeUndefined();
  });

  it("sends no header when the signing secret is missing, rather than an unsigned link", async () => {
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET;
    const { provider, dispatchEmail } = makeProvider();
    await provider.send(input());
    expect(headersOf(dispatchEmail)).toBeUndefined();
  });

  it("trims a trailing slash so the path is not doubled", async () => {
    process.env.PUBLIC_API_URL = `${API_ORIGIN}/`;
    const { provider, dispatchEmail } = makeProvider();
    await provider.send(input());

    const url = headersOf(dispatchEmail)!["List-Unsubscribe"]!;
    expect(url).not.toContain("//notifications");
  });
});
