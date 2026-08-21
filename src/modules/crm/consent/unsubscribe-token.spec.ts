import {
  buildUnsubscribeToken,
  verifyUnsubscribeToken,
} from "./unsubscribe-token.util";

const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "u".repeat(64);
});

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
});

const PAYLOAD = { orgId: "org-1", contactId: 42, channel: "EMAIL" as const };

describe("unsubscribe tokens", () => {
  it("round-trips a payload", () => {
    expect(verifyUnsubscribeToken(buildUnsubscribeToken(PAYLOAD))).toEqual(PAYLOAD);
  });

  it("does not embed a guessable id — the token is not just the contact id", () => {
    const token = buildUnsubscribeToken(PAYLOAD);
    expect(token).not.toBe("42");
    expect(token.split(".")).toHaveLength(3);
  });

  it("rejects a tampered payload, which is the whole point", () => {
    const [version, body, sig] = buildUnsubscribeToken(PAYLOAD).split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...PAYLOAD, contactId: 999 }),
      "utf8",
    ).toString("base64url");

    expect(verifyUnsubscribeToken(`${version}.${forged}.${sig}`)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const [version, body] = buildUnsubscribeToken(PAYLOAD).split(".");
    expect(verifyUnsubscribeToken(`${version}.${body}.deadbeef`)).toBeNull();
  });

  it("rejects a token signed with a different key", () => {
    const token = buildUnsubscribeToken(PAYLOAD);
    process.env.ENCRYPTION_KEY = "z".repeat(64);
    const result = verifyUnsubscribeToken(token);
    process.env.ENCRYPTION_KEY = "u".repeat(64);

    expect(result).toBeNull();
  });

  it("rejects malformed input rather than throwing", () => {
    for (const bad of ["", "x", "a.b", "a.b.c.d", "u1..sig", "not-a-token"]) {
      expect(verifyUnsubscribeToken(bad)).toBeNull();
    }
  });

  it("rejects a valid signature over a structurally invalid payload", () => {
    // Signed correctly, but channel is not a real channel and contactId is not
    // a positive integer — verification must check the shape, not just the MAC.
    const bad = buildUnsubscribeToken({
      orgId: "org-1",
      contactId: -1,
      channel: "EMAIL",
    });
    expect(verifyUnsubscribeToken(bad)).toBeNull();
  });

  it("is deterministic, so the same contact yields a stable link", () => {
    expect(buildUnsubscribeToken(PAYLOAD)).toBe(buildUnsubscribeToken(PAYLOAD));
  });
});
