import { buildSeededProcessEnvironment, assertSeededProcessIsolation, seededWorkerFlags } from "../helpers/seeded-process-environment";

const source = {
  DATABASE_URL: "postgres://owner:secret@host/neondb?sslmode=require",
  APP_DATABASE_URL: "postgres://streamline_app:secret@host/neondb?sslmode=require",
  REGION_EU_APP_DATABASE_URL: "postgres://live:secret@other/live",
  UPSTASH_REDIS_REST_TOKEN: "live-token", RESEND_API_KEY: "live-key", ENCRYPTION_KEY: "live-key",
};

describe("isolated seeded process environment", () => {
  it("retargets both roles and discards inherited regional/provider configuration", () => {
    const env = buildSeededProcessEnvironment(source, "scratch_e2e");
    expect(new URL(env.DATABASE_URL ?? "").pathname).toBe("/scratch_e2e");
    expect(new URL(env.APP_DATABASE_URL ?? "").username).toBe("streamline_app");
    expect(env.REGION_EU_APP_DATABASE_URL).toBeUndefined();
    expect(env.UPSTASH_REDIS_REST_TOKEN).toBeUndefined();
    expect(env.RESEND_API_KEY).toBeUndefined();
    expect(env.ENCRYPTION_KEY).not.toBe(source.ENCRYPTION_KEY);
    expect(() => assertSeededProcessIsolation(env)).not.toThrow();
    expect(source.DATABASE_URL).toContain("/neondb");
  });

  it.each(["neondb", "live_scratch", "scratch_e2e/other", "scratch_e2e?options=x", "SCRATCH_E2E"])("rejects ambiguous target %s", (target) => {
    expect(() => buildSeededProcessEnvironment(source, target)).toThrow();
  });

  it("refuses application role fallback and different physical servers", () => {
    expect(() => buildSeededProcessEnvironment({ ...source, APP_DATABASE_URL: source.DATABASE_URL }, "scratch_e2e")).toThrow();
    expect(() => buildSeededProcessEnvironment({ ...source, APP_DATABASE_URL: "postgres://app:p@other/neondb" }, "scratch_e2e")).toThrow();
  });

  it("catches a live regional URL reintroduced after process construction", () => {
    const env = buildSeededProcessEnvironment(source, "scratch_e2e");
    expect(() => assertSeededProcessIsolation({ ...env, REGION_EU_APP_DATABASE_URL: source.REGION_EU_APP_DATABASE_URL })).toThrow();
    expect(() => assertSeededProcessIsolation({ ...env, DB_REPLICA_URL: source.DATABASE_URL })).toThrow();
    expect(() => assertSeededProcessIsolation({ ...env, DB_REPLICA_URL: "postgres://app:p@other/scratch_e2e" })).toThrow();
  });

  it("refuses inherited delivery credentials and direct harness execution", () => {
    const env = buildSeededProcessEnvironment(source, "scratch_e2e");
    expect(() => assertSeededProcessIsolation({ ...env, RESEND_API_KEY: "secret" })).toThrow();
    expect(() => assertSeededProcessIsolation({ ...env, SEEDED_E2E_ISOLATED: undefined })).toThrow();
  });

  it("preserves explicit performance fixture and artifact inputs without inheriting keys", () => {
    const env = buildSeededProcessEnvironment({
      ...source, SEED_ORG_ID: "large-org", SEED_MINORITY_ORG_ID: "small-org",
      ROUTE_BUDGET_HTTP_ARTIFACT: "capture.json", ROUTE_BUDGET_HTTP_SKIP_WRITES: "1",
      AUTH_SIGNING_KEYS: "live-keyring",
    }, "scratch_e2e");
    expect(env.SEED_ORG_ID).toBe("large-org");
    expect(env.SEED_MINORITY_ORG_ID).toBe("small-org");
    expect(env.ROUTE_BUDGET_HTTP_ARTIFACT).toBe("capture.json");
    expect(env.ROUTE_BUDGET_HTTP_SKIP_WRITES).toBe("1");
    expect(env.AUTH_SIGNING_KEYS).not.toBe("live-keyring");
  });

  it.each(seededWorkerFlags)("refuses enabled automatic worker %s", (flag) => {
    const env = buildSeededProcessEnvironment(source, "scratch_e2e");
    expect(() => assertSeededProcessIsolation({ ...env, [flag]: "true" })).toThrow();
  });
});
