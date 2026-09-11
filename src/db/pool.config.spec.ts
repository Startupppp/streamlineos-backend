import {
  describeTimezoneRisk,
  normalizeDatabaseUrl,
  resolvePoolConfig,
  resolveTransactionGuards,
} from "./pool.config";

const POOLED = "postgres://streamline_app:pw@ep-x-pooler.us-east-2.aws.neon.tech/db?sslmode=require";
const DIRECT = "postgres://streamline_app:pw@ep-x.us-east-2.aws.neon.tech/db?sslmode=require";
const SELF_HOSTED = "postgres://app:pw@db.internal:5432/streamlineos";
const AURORA = "postgresql://streamline_app:pw@streamlineos.cluster-abc123.ap-south-1.rds.amazonaws.com:5432/streamlineos?sslmode=require";
const RDS = "postgresql://streamline_app:pw@streamlineos.abc123.ap-south-1.rds.amazonaws.com:5432/streamlineos?sslmode=require";

const UTC_PROCESS = { utcOffsetMinutes: 0 };
const IST_PROCESS = { utcOffsetMinutes: -330 };

function resolve(env: NodeJS.ProcessEnv, runtime = UTC_PROCESS) {
  return resolvePoolConfig({ NODE_ENV: "production", APP_DATABASE_URL: POOLED, ...env }, runtime);
}

describe("resolvePoolConfig", () => {
  it("throws when neither database url is set", () => {
    expect(() => resolvePoolConfig({ NODE_ENV: "production" }, UTC_PROCESS)).toThrow(/is required/);
  });

  it("reports the owner role when APP_DATABASE_URL is absent, because BYPASSRLS disables every policy", () => {
    expect(
      resolvePoolConfig({ NODE_ENV: "production", DATABASE_URL: POOLED }, UTC_PROCESS).role,
    ).toBe("owner");
    expect(resolve({}).role).toBe("application");
  });

  it("detects a transaction-mode pooler from the endpoint host", () => {
    expect(resolve({}).isPooled).toBe(true);
    expect(resolve({ APP_DATABASE_URL: DIRECT }).isPooled).toBe(false);
    expect(resolve({ APP_DATABASE_URL: SELF_HOSTED }).isNeon).toBe(false);
  });

  it("detects AWS RDS and Aurora endpoints separately from Neon", () => {
    const aurora = resolve({ APP_DATABASE_URL: AURORA });
    expect(aurora.isAwsRds).toBe(true);
    expect(aurora.isAurora).toBe(true);
    expect(aurora.isNeon).toBe(false);

    const rds = resolve({ APP_DATABASE_URL: RDS });
    expect(rds.isAwsRds).toBe(true);
    expect(rds.isAurora).toBe(false);
  });

  it("keeps max small on a direct Neon endpoint and larger behind the pooler", () => {
    expect(resolve({}).max).toBe(20);
    expect(resolve({ APP_DATABASE_URL: DIRECT }).max).toBe(10);
    expect(resolve({ NODE_ENV: "development" }).max).toBe(5);
    expect(resolve({ APP_DATABASE_URL: AURORA }).max).toBe(10);
  });

  it("uses resume-tolerant, scale-to-zero-friendly Aurora pool defaults", () => {
    const config = resolve({ APP_DATABASE_URL: AURORA });
    expect(config.options.idle_timeout).toBe(15);
    expect(config.options.connect_timeout).toBe(30);
    expect(config.options.max_lifetime).toBe(15 * 60);
  });

  it("disables prepared statements, which a transaction-mode pooler cannot serve", () => {
    expect(resolve({}).options.prepare).toBe(false);
  });

  it("sends application_name and a pinned TimeZone, the startup parameters the pooler tracks", () => {
    const { connection } = resolve({}).options;
    expect(connection).toEqual({ application_name: "streamlineos-api", TimeZone: "UTC" });
  });

  it("keeps TimeZone pinned even when the application name is overridden", () => {
    const { connection } = resolve({ DB_APPLICATION_NAME: "streamlineos-api-cron" }).options;
    expect(connection?.TimeZone).toBe("UTC");
  });

  it("keeps the timeouts out of the startup packet, where the pooler drops them", () => {
    const { connection } = resolve({ DB_STATEMENT_TIMEOUT_MS: "45000" }).options;
    expect(connection?.statement_timeout).toBeUndefined();
    expect(connection?.idle_in_transaction_session_timeout).toBeUndefined();
    expect(connection?.lock_timeout).toBeUndefined();
  });

  it("resolves the guards applied per transaction instead", () => {
    expect(resolve({}).guards).toEqual({
      statementTimeoutMs: 30_000,
      idleInTransactionMs: 60_000,
      lockTimeoutMs: 5_000,
    });
  });

  it("treats 0 as disabling a guard rather than as a zero timeout", () => {
    const guards = resolve({ DB_STATEMENT_TIMEOUT_MS: "0" }).guards;
    expect(guards.statementTimeoutMs).toBe(0);
    expect(guards.idleInTransactionMs).toBe(60_000);
  });

  it("lets the environment override every default", () => {
    const config = resolve({
      DB_POOL_MAX: "40",
      DB_POOL_IDLE_TIMEOUT: "5",
      DB_POOL_CONNECT_TIMEOUT: "8",
      DB_POOL_MAX_LIFETIME: "120",
      DB_POOL_SHUTDOWN_TIMEOUT: "12",
      DB_LOCK_TIMEOUT_MS: "2000",
      DB_SLOW_ACQUIRE_MS: "100",
      DB_APPLICATION_NAME: "streamlineos-api-cron",
    });

    expect(config.max).toBe(40);
    expect(config.options.idle_timeout).toBe(5);
    expect(config.options.connect_timeout).toBe(8);
    expect(config.options.max_lifetime).toBe(120);
    expect(config.shutdownTimeoutSeconds).toBe(12);
    expect(config.guards.lockTimeoutMs).toBe(2_000);
    expect(config.slowAcquireMs).toBe(100);
    expect(config.options.connection?.application_name).toBe("streamlineos-api-cron");
  });

  it("rejects an unparseable pool setting instead of silently falling back", () => {
    expect(() => resolve({ DB_POOL_MAX: "twenty" })).toThrow(/Invalid pool configuration/);
    expect(() => resolve({ DB_POOL_MAX: "0" })).toThrow(/Invalid pool configuration/);
    expect(() => resolve({ DB_REPLICA_URL: "mysql://u:p@localhost/db" })).toThrow(
      /Invalid pool configuration/,
    );
    expect(() =>
      resolve({ DB_REPLICA_URL: "postgresql://u:p@replica.abc.ap-south-1.rds.amazonaws.com/db" }),
    ).toThrow(/enable sslmode/);
  });

  it("requires TLS to Neon even if sslmode is dropped from the url", () => {
    expect(resolve({}).options.ssl).toBe("require");
    expect(resolve({ APP_DATABASE_URL: SELF_HOSTED }).options.ssl).toBeUndefined();
    expect(resolve({ APP_DATABASE_URL: AURORA }).options.ssl).toBe("require");
  });

  it("warns when a direct Neon endpoint is asked for more connections than it can spare", () => {
    const warnings = resolve({ APP_DATABASE_URL: DIRECT, DB_POOL_MAX: "40" }).warnings;
    expect(warnings.join(" ")).toMatch(/direct Neon endpoint/);
    expect(resolve({ DB_POOL_MAX: "40" }).warnings).toEqual([]);
  });

  it("warns when an AWS pool can multiply into excessive connections", () => {
    expect(
      resolve({ APP_DATABASE_URL: AURORA, DB_POOL_MAX: "21" }).warnings.join(" "),
    ).toMatch(/total possible connections/);
  });

  it("warns in production when a disabled guard would let a connection be pinned forever", () => {
    expect(resolve({ DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: "0" }).warnings.join(" ")).toMatch(
      /pins its connection indefinitely/,
    );
    expect(
      resolve({ NODE_ENV: "development", DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: "0" }).warnings,
    ).toEqual([]);
  });

  it("warns when idleness is bounded more tightly than a legitimate long query", () => {
    expect(
      resolve({ DB_STATEMENT_TIMEOUT_MS: "60000", DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: "5000" })
        .warnings.join(" "),
    ).toMatch(/below statement_timeout/);
  });
});

describe("resolveTransactionGuards", () => {
  it("resolves without a database url, because withTenant reads it at module load", () => {
    expect(resolveTransactionGuards({})).toEqual({
      statementTimeoutMs: 30_000,
      idleInTransactionMs: 60_000,
      lockTimeoutMs: 5_000,
    });
  });

  it("honours overrides", () => {
    expect(resolveTransactionGuards({ DB_LOCK_TIMEOUT_MS: "0" }).lockTimeoutMs).toBe(0);
  });
});

describe("timezone pinning", () => {
  it("says nothing when the process already runs at UTC, which is the only safe pairing", () => {
    expect(describeTimezoneRisk(0)).toBeNull();
    expect(resolve({}).warnings).toEqual([]);
  });

  it("names the exact drift when the process is not at UTC, because pinning only one end shifts every naive column", () => {
    const risk = describeTimezoneRisk(-330);
    expect(risk).toMatch(/UTC\+5\.5/);
    expect(risk).toMatch(/shifted by 5\.5 hours/);
    expect(risk).toMatch(/TZ=UTC/);
    expect(resolve({}, IST_PROCESS).warnings.join(" ")).toMatch(/timestamp without time zone/);
  });

  it("reports a western offset with its sign, not its magnitude", () => {
    expect(describeTimezoneRisk(300)).toMatch(/UTC-5/);
  });
});

describe("normalizeDatabaseUrl", () => {
  it("strips channel_binding, which Neon fails on without reporting why", () => {
    expect(normalizeDatabaseUrl(`${POOLED}&channel_binding=require`)).not.toMatch(
      /channel_binding/,
    );
  });

  it("leaves a non-Neon url untouched", () => {
    expect(normalizeDatabaseUrl(SELF_HOSTED)).toBe(SELF_HOSTED);
  });
});
