import { createUnsubscribeToken, verifyUnsubscribeToken } from "./unsubscribe-token";

const SUBJECT = {
  userId: "user-1",
  orgId: "org-1",
  email: "person@example.com",
  scope: "ALL_NON_MANDATORY" as const,
  scopeKey: "",
};

describe("unsubscribe token", () => {
  const original = process.env.UNSUBSCRIBE_TOKEN_SECRET;

  beforeEach(() => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = "a".repeat(48);
  });

  afterAll(() => {
    if (original === undefined) delete process.env.UNSUBSCRIBE_TOKEN_SECRET;
    else process.env.UNSUBSCRIBE_TOKEN_SECRET = original;
  });

  it("round-trips a valid token", () => {
    const token = createUnsubscribeToken(SUBJECT);
    expect(token).not.toBeNull();
    const payload = verifyUnsubscribeToken(token as string);
    expect(payload).toMatchObject(SUBJECT);
  });

  it("rejects a tampered payload", () => {
    const token = createUnsubscribeToken(SUBJECT) as string;
    const [body, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...SUBJECT, userId: "someone-else", expiresAt: Date.now() + 1000, nonce: "x" }),
    ).toString("base64url");
    expect(body).not.toBe(forged);
    expect(verifyUnsubscribeToken(`${forged}.${sig}`)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = createUnsubscribeToken(SUBJECT) as string;
    process.env.UNSUBSCRIBE_TOKEN_SECRET = "b".repeat(48);
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = createUnsubscribeToken(SUBJECT, Date.now() - 40 * 24 * 3600 * 1000) as string;
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it("fails closed when no secret is configured", () => {
    const token = createUnsubscribeToken(SUBJECT) as string;
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET;
    expect(createUnsubscribeToken(SUBJECT)).toBeNull();
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it("rejects a secret shorter than 32 characters rather than signing weakly", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = "too-short";
    expect(createUnsubscribeToken(SUBJECT)).toBeNull();
  });

  it("rejects garbage", () => {
    expect(verifyUnsubscribeToken("not-a-token")).toBeNull();
    expect(verifyUnsubscribeToken("")).toBeNull();
    expect(verifyUnsubscribeToken("a.b")).toBeNull();
  });

  // The token names its subject, so one user's link cannot be replayed for another.
  it("binds the token to one user, org and address", () => {
    const a = createUnsubscribeToken(SUBJECT) as string;
    const b = createUnsubscribeToken({ ...SUBJECT, userId: "user-2" }) as string;
    expect(verifyUnsubscribeToken(a)?.userId).toBe("user-1");
    expect(verifyUnsubscribeToken(b)?.userId).toBe("user-2");
    expect(a).not.toBe(b);
  });
});
