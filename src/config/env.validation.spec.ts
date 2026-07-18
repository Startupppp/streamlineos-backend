import { validateEnv } from "./env.validation";

describe("validateEnv", () => {
  const base = {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    BACKEND_JWT_SECRET: "x".repeat(44),
    CORS_ORIGINS: "https://app.example.com",
    APP_URL: "https://app.example.com",
  };

  it("parses a valid environment", () => {
    const cfg = validateEnv(base);
    expect(cfg.PORT).toBe(1500);
    expect(cfg.corsOrigins).toEqual(["https://app.example.com"]);
  });

  it("throws when BACKEND_JWT_SECRET is too short", () => {
    expect(() => validateEnv({ ...base, BACKEND_JWT_SECRET: "short" })).toThrow(
      /BACKEND_JWT_SECRET/,
    );
  });

  it("throws when DATABASE_URL is missing", () => {
    const { DATABASE_URL, ...rest } = base;
    expect(() => validateEnv(rest)).toThrow(/DATABASE_URL/);
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
});
