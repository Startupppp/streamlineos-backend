import { EnvSmsSender } from "../env-sms-sender";

/**
 * The sender that ships, and what it promises.
 *
 * The value of this class is entirely in what it refuses to do. A no-op `send`
 * that resolved would report every one-time code as sent and leave signers
 * waiting for a message nobody dispatched — which is worse than the broken
 * menu entry it replaces, because it would look like it worked.
 */
describe("EnvSmsSender", () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  const withEnv = (env: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return new EnvSmsSender();
  };

  it("reports itself unconfigured when no provider is set", () => {
    const sender = withEnv({ SIGN_SMS_PROVIDER_URL: undefined, SIGN_SMS_PROVIDER_TOKEN: undefined });
    expect(sender.isConfigured()).toBe(false);
  });

  it("needs both halves of the credential, not one", () => {
    expect(
      withEnv({ SIGN_SMS_PROVIDER_URL: "https://example.invalid", SIGN_SMS_PROVIDER_TOKEN: undefined }).isConfigured(),
    ).toBe(false);
    expect(
      withEnv({ SIGN_SMS_PROVIDER_URL: undefined, SIGN_SMS_PROVIDER_TOKEN: "t" }).isConfigured(),
    ).toBe(false);
  });

  it("throws rather than silently succeeding when asked to send unconfigured", async () => {
    const sender = withEnv({ SIGN_SMS_PROVIDER_URL: undefined, SIGN_SMS_PROVIDER_TOKEN: undefined });
    await expect(sender.send("+15550100", "code")).rejects.toThrow(/not configured/i);
  });

  /**
   * Credentials present is still not an implementation. Writing an HTTP call
   * against an imagined provider would ship green and fail the first time real
   * credentials appeared; throwing says which piece is missing.
   */
  it("still throws when credentials exist but no provider is bound", async () => {
    const sender = withEnv({
      SIGN_SMS_PROVIDER_URL: "https://example.invalid",
      SIGN_SMS_PROVIDER_TOKEN: "t",
    });
    expect(sender.isConfigured()).toBe(true);
    await expect(sender.send("+15550100", "code")).rejects.toThrow(/no provider implementation/i);
  });

  /**
   * Read once at construction. If availability could change between the check
   * made when an envelope is configured and the send attempted when it is
   * signed, a recipient set up on Monday would become unsignable on Tuesday.
   */
  it("does not change its answer when the environment moves underneath it", () => {
    const sender = withEnv({ SIGN_SMS_PROVIDER_URL: undefined, SIGN_SMS_PROVIDER_TOKEN: undefined });
    expect(sender.isConfigured()).toBe(false);

    process.env.SIGN_SMS_PROVIDER_URL = "https://example.invalid";
    process.env.SIGN_SMS_PROVIDER_TOKEN = "t";

    expect(sender.isConfigured()).toBe(false);
  });
});
