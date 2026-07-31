import { validateEnv } from "./env.validation";

describe("validateEnv", () => {
  const base = {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    BACKEND_JWT_SECRET: "x".repeat(44),
    PORTAL_JWT_SECRET: "y".repeat(44),
    CORS_ORIGINS: "https://app.example.com",
    APP_URL: "https://app.example.com",
    ENCRYPTION_KEY: "e".repeat(64),
  };

  it("parses a valid environment", () => {
    const cfg = validateEnv(base);
    expect(cfg.PORT).toBe(1500);
    expect(cfg.corsOrigins).toEqual(["https://app.example.com"]);
  });

  it("throws when ENCRYPTION_KEY is missing", () => {
    expect(() => validateEnv({ ...base, ENCRYPTION_KEY: undefined })).toThrow(
      /ENCRYPTION_KEY/,
    );
  });

  it("throws when ENCRYPTION_KEY is too short to protect PII at rest", () => {
    expect(() => validateEnv({ ...base, ENCRYPTION_KEY: "short" })).toThrow(
      /ENCRYPTION_KEY/,
    );
  });

  it("throws when BACKEND_JWT_SECRET is too short", () => {
    expect(() => validateEnv({ ...base, BACKEND_JWT_SECRET: "short" })).toThrow(
      /BACKEND_JWT_SECRET/,
    );
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() => validateEnv({ ...base, DATABASE_URL: undefined })).toThrow(
      /DATABASE_URL/,
    );
  });

  it.each(["CRON_SECRET", "INTERNAL_API_SECRET"] as const)(
    "requires %s in production",
    (secretName) => {
      expect(() =>
        validateEnv({
          ...base,
          NODE_ENV: "production",
          CRON_SECRET: "x".repeat(32),
          INTERNAL_API_SECRET: "x".repeat(32),
          CONTACT_NOTIFICATION_EMAIL: "contact@example.com",
          [secretName]: undefined,
        }),
      ).toThrow(new RegExp(secretName));
    },
  );

  it("allows deployment-only secrets to be omitted outside production", () => {
    expect(validateEnv(base).NODE_ENV).toBe("test");
  });

  it("requires CONTACT_NOTIFICATION_EMAIL in production", () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: "production",
        CRON_SECRET: "x".repeat(32),
        INTERNAL_API_SECRET: "x".repeat(32),
        ADMIN_NOTIFICATION_EMAIL: "admin@example.com",
        OWNER_EMAIL: "owner@example.com",
      }),
    ).toThrow(/CONTACT_NOTIFICATION_EMAIL/);
  });

  it("rejects an invalid CONTACT_NOTIFICATION_EMAIL", () => {
    expect(() =>
      validateEnv({
        ...base,
        CONTACT_NOTIFICATION_EMAIL: "not-an-email",
      }),
    ).toThrow(/CONTACT_NOTIFICATION_EMAIL/);
  });

  it("accepts a valid email provider configuration", () => {
    const cfg = validateEnv({
      ...base,
      EMAIL_PROVIDER: "zeptomail",
      ZEPTOMAIL_API_URL: "https://api.zeptomail.in/v1.1/email",
      ZEPTOMAIL_TOKEN: "Zoho-enczapikey ".padEnd(60, "x"),
      EMAIL_FROM_ADDRESS: "support@example.com",
    });
    expect(cfg.EMAIL_PROVIDER).toBe("zeptomail");
  });

  it("treats empty email provider vars as unset", () => {
    const cfg = validateEnv({
      ...base,
      EMAIL_PROVIDER: "",
      ZEPTOMAIL_API_URL: "",
      ZEPTOMAIL_TOKEN: "",
    });
    expect(cfg.EMAIL_PROVIDER).toBeUndefined();
    expect(cfg.ZEPTOMAIL_TOKEN).toBeUndefined();
  });

  it("rejects a retired EMAIL_PROVIDER value", () => {
    expect(() =>
      validateEnv({ ...base, EMAIL_PROVIDER: "sendgrid" }),
    ).toThrow(/EMAIL_PROVIDER/);
  });

  it("rejects a truncated ZEPTOMAIL_TOKEN", () => {
    expect(() =>
      validateEnv({ ...base, ZEPTOMAIL_TOKEN: "too-short" }),
    ).toThrow(/ZEPTOMAIL_TOKEN/);
  });
});
