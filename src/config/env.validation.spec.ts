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
});
