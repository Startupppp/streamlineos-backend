import {
  listMembersSchema,
  securitySettingsSchema,
  updateOrgSettingsSchema,
} from "./organization.schemas";

describe("listMembersSchema", () => {
  it("rejects member page sizes above 100", () => {
    expect(listMembersSchema.parse({ limit: 101 }).limit).toBe(100);
  });
});

describe("updateOrgSettingsSchema", () => {
  it("accepts organization profile fields", () => {
    expect(
      updateOrgSettingsSchema.safeParse({ name: "Acme", timezone: "UTC" }).success,
    ).toBe(true);
  });

  it.each(["mfaEnforced", "allowedEmailDomains", "ipAllowlist"])(
    "refuses %s so PATCH /organization/security stays the only writer",
    (field) => {
      const body: Record<string, unknown> = {
        mfaEnforced: true,
        allowedEmailDomains: ["example.com"],
        ipAllowlist: ["10.0.0.1"],
      };
      expect(
        updateOrgSettingsSchema.safeParse({ [field]: body[field] }).success,
      ).toBe(false);
    },
  );

  it("rejects an unknown key rather than silently stripping it", () => {
    expect(
      updateOrgSettingsSchema.safeParse({ name: "Acme", createdById: "u-1" }).success,
    ).toBe(false);
  });
});

describe("securitySettingsSchema", () => {
  const listOf = (count: number, make: (i: number) => string) =>
    Array.from({ length: count }, (_, i) => make(i));

  it("accepts a security payload at the list ceiling", () => {
    expect(
      securitySettingsSchema.safeParse({
        mfaEnforced: true,
        allowedEmailDomains: listOf(100, (i) => `tenant${i}.example.com`),
        ipAllowlist: listOf(100, (i) => `10.0.0.${i}`),
        maxConcurrentSessions: 5,
      }).success,
    ).toBe(true);
  });

  it("bounds the allowed-domain list so one request cannot write unbounded rows", () => {
    expect(
      securitySettingsSchema.safeParse({
        allowedEmailDomains: listOf(101, (i) => `tenant${i}.example.com`),
      }).success,
    ).toBe(false);
  });

  it("bounds each allowed domain to a legal DNS name length", () => {
    expect(
      securitySettingsSchema.safeParse({
        allowedEmailDomains: [`${"a".repeat(254)}.com`],
      }).success,
    ).toBe(false);
  });

  it("bounds the IP allowlist and each entry", () => {
    expect(
      securitySettingsSchema.safeParse({ ipAllowlist: listOf(101, (i) => `10.0.1.${i}`) })
        .success,
    ).toBe(false);
    expect(
      securitySettingsSchema.safeParse({ ipAllowlist: ["1".repeat(129)] }).success,
    ).toBe(false);
  });

  it("rejects an unknown key rather than silently stripping it", () => {
    expect(
      securitySettingsSchema.safeParse({ mfaEnforced: true, orgId: "org-2" }).success,
    ).toBe(false);
  });
});
