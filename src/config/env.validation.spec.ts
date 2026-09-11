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

  it("rejects non-PostgreSQL and incomplete database URLs", () => {
    expect(() => validateEnv({ ...base, DATABASE_URL: "mysql://u:p@localhost/db" })).toThrow(
      /postgres:\/\/ or postgresql:\/\//,
    );
    expect(() => validateEnv({ ...base, DATABASE_URL: "postgresql://u:p@localhost" })).toThrow(
      /database name/,
    );
  });

  it("requires encrypted URLs for AWS RDS and Aurora endpoints", () => {
    expect(() =>
      validateEnv({
        ...base,
        DATABASE_URL: "postgresql://admin:pw@streamlineos.cluster-abc.ap-south-1.rds.amazonaws.com:5432/streamlineos",
      }),
    ).toThrow(/sslmode=require/);
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

  it("requires APP_DATABASE_URL in production so the app cannot run as the owner", () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: "production",
        CRON_SECRET: "x".repeat(32),
        INTERNAL_API_SECRET: "x".repeat(32),
        CONTACT_NOTIFICATION_EMAIL: "contact@example.com",
      }),
    ).toThrow(/APP_DATABASE_URL/);
  });

  it("rejects APP_DATABASE_URL pointing at the same role as DATABASE_URL", () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: "production",
        CRON_SECRET: "x".repeat(32),
        INTERNAL_API_SECRET: "x".repeat(32),
        CONTACT_NOTIFICATION_EMAIL: "contact@example.com",
        APP_DATABASE_URL: base.DATABASE_URL,
      }),
    ).toThrow(/different database user/);
  });

  it("rejects an application URL aimed at a different database", () => {
    expect(() =>
      validateEnv({
        ...base,
        APP_DATABASE_URL: "postgres://streamline_app:p@localhost:5432/other",
      }),
    ).toThrow(/same database and port/);
  });

  it("requires the application URL username to match APP_DB_ROLE", () => {
    expect(() =>
      validateEnv({
        ...base,
        APP_DB_ROLE: "runtime_app",
        APP_DATABASE_URL: "postgres://streamline_app:p@localhost:5432/db",
      }),
    ).toThrow(/must match APP_DB_ROLE/);
  });

  it("accepts the matching Aurora reader endpoint and restricted application role", () => {
    const writer = "streamlineos.cluster-abc.ap-south-1.rds.amazonaws.com";
    const reader = "streamlineos.cluster-ro-abc.ap-south-1.rds.amazonaws.com";
    const cfg = validateEnv({
      ...base,
      DATABASE_URL: `postgresql://admin:pw@${writer}/db?sslmode=require`,
      APP_DATABASE_URL: `postgresql://streamline_app:pw@${writer}/db?sslmode=require`,
      DB_REPLICA_URL: `postgresql://streamline_app:pw@${reader}/db?sslmode=require`,
    });
    expect(cfg.DB_REPLICA_URL).toContain("cluster-ro");
  });

  it("rejects a replica URL using owner credentials", () => {
    expect(() =>
      validateEnv({
        ...base,
        APP_DATABASE_URL: "postgres://streamline_app:p@localhost:5432/db",
        DB_REPLICA_URL: "postgres://u:p@localhost:5432/db",
      }),
    ).toThrow(/same restricted application role/);
  });

  it("accepts a distinct APP_DATABASE_URL in production", () => {
    expect(
      validateEnv({
        ...base,
        NODE_ENV: "production",
        CRON_SECRET: "x".repeat(32),
        INTERNAL_API_SECRET: "x".repeat(32),
        CONTACT_NOTIFICATION_EMAIL: "contact@example.com",
        APP_DATABASE_URL: "postgres://streamline_app:p@localhost:5432/db",
      }).APP_DATABASE_URL,
    ).toBe("postgres://streamline_app:p@localhost:5432/db");
  });

  it("accepts a password-authenticated TLS Aurora owner and application pair", () => {
    const host = "streamlineos.cluster-abc.ap-south-1.rds.amazonaws.com";
    const config = validateEnv({
      ...base,
      NODE_ENV: "production",
      CRON_SECRET: "c".repeat(32),
      INTERNAL_API_SECRET: "i".repeat(32),
      CONTACT_NOTIFICATION_EMAIL: "contact@example.com",
      DATABASE_URL: `postgresql://streamline_admin:owner-password@${host}:5432/streamlineos?sslmode=require`,
      DIRECT_DATABASE_URL: `postgresql://streamline_admin:owner-password@${host}:5432/streamlineos?sslmode=require`,
      APP_DATABASE_URL: `postgresql://streamline_app:application-password@${host}:5432/streamlineos?sslmode=require`,
    });
    expect(config.APP_DATABASE_URL).toContain("streamline_app");
  });

  it("rejects passwordless AWS URLs because the runtime does not mint IAM tokens", () => {
    const host = "streamlineos.cluster-abc.ap-south-1.rds.amazonaws.com";
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: "production",
        CRON_SECRET: "c".repeat(32),
        INTERNAL_API_SECRET: "i".repeat(32),
        CONTACT_NOTIFICATION_EMAIL: "contact@example.com",
        DATABASE_URL: `postgresql://streamline_admin@${host}:5432/streamlineos?sslmode=require`,
        APP_DATABASE_URL: `postgresql://streamline_app@${host}:5432/streamlineos?sslmode=require`,
      }),
    ).toThrow(/IAM-only authentication is not supported/);
  });

  it("does not require APP_DATABASE_URL outside production", () => {
    expect(validateEnv(base).APP_DATABASE_URL).toBeUndefined();
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
