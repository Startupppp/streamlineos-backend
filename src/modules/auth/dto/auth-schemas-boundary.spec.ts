import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  googleOAuthSchema,
  magicLinkRequestSchema,
  magicLinkVerifySchema,
  requestEmailOtpSchema,
  resendVerificationSchema,
  verifyEmailOtpSchema,
  verifyEmailSchema,
} from "./auth.schemas";

/**
 * The malformed-request half of the identity boundary. `ZodValidationInterceptor`
 * is global and maps a `ZodError` to 400, so what decides whether a hostile body
 * reaches a service is the schema — and every one of these is `.strict()`, which
 * is the property that stops a client posting `role` or `isPlatformAdmin`
 * alongside a legitimate field.
 *
 * The rate-limited half of the same gap is proved in
 * `auth-internal-secret-gate.spec.ts`, and hostile `sessionExchangeSchema` input
 * in `test/security/appsec/session-fixation-replay-and-credentials.spec.ts`;
 * neither is repeated here.
 */

function rejects(schema: z.ZodType, value: unknown): boolean {
  return !schema.safeParse(value).success;
}

const TOKEN_SCHEMAS: Array<[string, z.ZodType]> = [
  ["verifyEmailSchema", verifyEmailSchema],
  ["magicLinkVerifySchema", magicLinkVerifySchema],
];

const EMAIL_SCHEMAS: Array<[string, z.ZodType]> = [
  ["resendVerificationSchema", resendVerificationSchema],
  ["magicLinkRequestSchema", magicLinkRequestSchema],
  ["requestEmailOtpSchema", requestEmailOtpSchema],
];

describe("token-bearing auth bodies", () => {
  it.each(TOKEN_SCHEMAS)("%s accepts a token and nothing else", (_name, schema) => {
    expect(schema.safeParse({ token: "a".repeat(64) }).success).toBe(true);
    expect(schema.safeParse({ token: "a".repeat(256) }).success).toBe(true);
  });

  it.each(TOKEN_SCHEMAS)("%s refuses every malformed token", (_name, schema) => {
    const hostile: unknown[] = [
      {},
      { token: "" },
      { token: "a".repeat(257) },
      { token: 12345 },
      { token: null },
      { token: ["a"] },
      { token: { toString: "a" } },
      null,
      "a-bare-string",
      [],
    ];
    expect(hostile.filter((value) => rejects(schema, value))).toHaveLength(hostile.length);
  });

  it.each(TOKEN_SCHEMAS)("%s refuses a smuggled extra field", (_name, schema) => {
    expect(rejects(schema, { token: "abc", userId: "someone-else" })).toBe(true);
    expect(rejects(schema, { token: "abc", role: "OWNER" })).toBe(true);
  });
});

describe("email-bearing auth bodies", () => {
  it.each(EMAIL_SCHEMAS)("%s accepts a plain address", (_name, schema) => {
    expect(schema.safeParse({ email: "person@example.com" }).success).toBe(true);
  });

  it.each(EMAIL_SCHEMAS)("%s refuses every malformed address", (_name, schema) => {
    const hostile: unknown[] = [
      {},
      { email: "" },
      { email: "not-an-email" },
      { email: "person@" },
      { email: "@example.com" },
      { email: `${"a".repeat(250)}@example.com` },
      { email: 42 },
      { email: null },
      { email: ["person@example.com"] },
      null,
    ];
    expect(hostile.filter((value) => rejects(schema, value))).toHaveLength(hostile.length);
  });

  it.each(EMAIL_SCHEMAS)("%s refuses a smuggled extra field", (_name, schema) => {
    expect(rejects(schema, { email: "a@b.com", orgId: "another-org" })).toBe(true);
    expect(rejects(schema, { email: "a@b.com", isPlatformAdmin: true })).toBe(true);
  });
});

describe("verifyEmailOtpSchema — the code is exactly six digits", () => {
  it("accepts a six-digit code, including one with leading zeros", () => {
    expect(verifyEmailOtpSchema.safeParse({ email: "a@b.com", code: "000123" }).success).toBe(true);
  });

  it("refuses every code that is not six digits", () => {
    const hostile: unknown[] = [
      { email: "a@b.com", code: "12345" },
      { email: "a@b.com", code: "1234567" },
      { email: "a@b.com", code: "12345a" },
      { email: "a@b.com", code: " 123456" },
      { email: "a@b.com", code: "123456 " },
      { email: "a@b.com", code: "12 3456" },
      { email: "a@b.com", code: "" },
      { email: "a@b.com", code: 123456 },
      { email: "a@b.com", code: null },
      { email: "a@b.com" },
      { code: "123456" },
    ];
    expect(hostile.filter((value) => rejects(verifyEmailOtpSchema, value))).toHaveLength(
      hostile.length,
    );
  });

  it("refuses a smuggled extra field alongside a valid code", () => {
    expect(
      rejects(verifyEmailOtpSchema, { email: "a@b.com", code: "123456", attempts: 0 }),
    ).toBe(true);
  });
});

describe("googleOAuthSchema — the internal-secret identity body", () => {
  it("accepts the minimum body and the fully populated one", () => {
    expect(googleOAuthSchema.safeParse({ email: "a@b.com", googleId: "g-1" }).success).toBe(true);
    expect(
      googleOAuthSchema.safeParse({
        email: "a@b.com",
        googleId: "g-1",
        name: "A Person",
        image: "https://cdn.example.com/a.png",
      }).success,
    ).toBe(true);
    expect(
      googleOAuthSchema.safeParse({ email: "a@b.com", googleId: "g-1", image: "" }).success,
    ).toBe(true);
  });

  it("refuses every malformed identity body", () => {
    const hostile: unknown[] = [
      { googleId: "g-1" },
      { email: "a@b.com" },
      { email: "not-an-email", googleId: "g-1" },
      { email: "a@b.com", googleId: "" },
      { email: "a@b.com", googleId: "g".repeat(256) },
      { email: "a@b.com", googleId: 1 },
      { email: "a@b.com", googleId: "g-1", name: "n".repeat(201) },
      { email: "a@b.com", googleId: "g-1", image: "javascript:alert(1)" },
      { email: "a@b.com", googleId: "g-1", image: "data:text/html;base64,PHNjcmlwdD4=" },
      { email: "a@b.com", googleId: "g-1", image: "file:///etc/passwd" },
      { email: "a@b.com", googleId: "g-1", image: `https://x.test/${"a".repeat(2048)}` },
    ];
    expect(hostile.filter((value) => rejects(googleOAuthSchema, value))).toHaveLength(
      hostile.length,
    );
  });

  it("refuses a body that tries to name its own user, org or standing", () => {
    const base = { email: "a@b.com", googleId: "g-1" };
    expect(rejects(googleOAuthSchema, { ...base, userId: "u-9" })).toBe(true);
    expect(rejects(googleOAuthSchema, { ...base, orgId: "o-9" })).toBe(true);
    expect(rejects(googleOAuthSchema, { ...base, isPlatformAdmin: true })).toBe(true);
    expect(rejects(googleOAuthSchema, { ...base, sessionId: "s-9" })).toBe(true);
  });
});

describe("the schemas are actually applied at the boundary", () => {
  // A schema that is never named in a `@Validate` is a document, not a gate.
  const controller = readFileSync(join(__dirname, "..", "auth.controller.ts"), "utf-8");

  it.each([
    "verifyEmailSchema",
    "resendVerificationSchema",
    "magicLinkRequestSchema",
    "magicLinkVerifySchema",
    "googleOAuthSchema",
    "requestEmailOtpSchema",
    "verifyEmailOtpSchema",
    "sessionExchangeSchema",
  ])("%s is declared on a handler", (name) => {
    expect(controller).toContain(`@Validate({ body: ${name} })`);
  });

  it("(negative) the scan would notice a schema that was never wired", () => {
    expect(controller).not.toContain("@Validate({ body: notAWiredSchema })");
  });
});
