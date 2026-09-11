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
  /**
   * The credential pair is handed in, not set in the environment.
   *
   * It used to be `process.env`, and that made the spec quietly weaker than it
   * looked: jest gives each test file its own copy of `process.env`, so the
   * value a test set was never the one a booted server would read, and the test
   * could only ever describe a deployment nobody runs. Constructing with the
   * config states the deployment being described, in the test.
   */
  const withEnv = (env: {
    SIGN_SMS_PROVIDER_URL?: string;
    SIGN_SMS_PROVIDER_TOKEN?: string;
  }) =>
    new EnvSmsSender({
      SIGN_SMS_PROVIDER_URL: env.SIGN_SMS_PROVIDER_URL,
      SIGN_SMS_PROVIDER_TOKEN: env.SIGN_SMS_PROVIDER_TOKEN,
    } as Pick<
      import("../../../../config/env.validation").AppConfig,
      "SIGN_SMS_PROVIDER_URL" | "SIGN_SMS_PROVIDER_TOKEN"
    >);

  it("reports itself unconfigured when no provider is set", () => {
    const sender = withEnv({});
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
    const sender = withEnv({});
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
    const sender = withEnv({});
    expect(sender.isConfigured()).toBe(false);

    process.env.SIGN_SMS_PROVIDER_URL = "https://example.invalid";
    process.env.SIGN_SMS_PROVIDER_TOKEN = "t";

    expect(sender.isConfigured()).toBe(false);
  });
});
