import { resolvePoolMax, resolveTransactionGuards } from "../../db/pool.config";
import { DEFAULT_QUEUE_DEPTH_FACTOR } from "../../db/pool-admission";
import { resolveAdmissionConfig } from "./admission.config";

describe("admission is sized from the database it fronts", () => {
  it("admits no more than the pool can hold active plus queued", () => {
    const env = { DB_POOL_MAX: "15" };

    const config = resolveAdmissionConfig(env);

    expect(config.maxConcurrent).toBe(15 * (1 + DEFAULT_QUEUE_DEPTH_FACTOR));
  });

  it("follows DB_POOL_MAX so the two gates cannot drift apart", () => {
    expect(resolveAdmissionConfig({ DB_POOL_MAX: "10" }).maxConcurrent).toBe(
      10 * (1 + DEFAULT_QUEUE_DEPTH_FACTOR),
    );
    expect(resolveAdmissionConfig({ DB_POOL_MAX: "40" }).maxConcurrent).toBe(
      40 * (1 + DEFAULT_QUEUE_DEPTH_FACTOR),
    );
  });

  it("keeps one organization's ceiling below the global one at every pool size", () => {
    for (const DB_POOL_MAX of ["1", "5", "10", "15", "40"]) {
      const config = resolveAdmissionConfig({ DB_POOL_MAX });
      expect(config.orgMaxConcurrent).toBeLessThan(config.maxConcurrent);
      expect(config.orgMaxConcurrent).toBeGreaterThan(0);
    }
  });

  it("still lets an operator pin the concurrency explicitly", () => {
    expect(
      resolveAdmissionConfig({ DB_POOL_MAX: "15", ADMISSION_MAX_CONCURRENT: "500" })
        .maxConcurrent,
    ).toBe(500);
  });

  it("resolves a pool size with no database url, because it is read at import time", () => {
    expect(resolvePoolMax({})).toBeGreaterThan(0);
    expect(resolvePoolMax({ NODE_ENV: "development" })).toBe(5);
  });
});

describe("admission limits are real numbers, not defaults nobody set", () => {
  it("is enabled unless explicitly turned off", () => {
    expect(resolveAdmissionConfig({}).enabled).toBe(true);
    expect(resolveAdmissionConfig({ ADMISSION_ENABLED: "false" }).enabled).toBe(false);
  });

  it("bounds concurrency, queue depth, body size and per-organization cost", () => {
    const config = resolveAdmissionConfig({});

    expect(config.maxConcurrent).toBeGreaterThan(0);
    expect(config.maxQueueDepth).toBeGreaterThanOrEqual(config.maxConcurrent);
    expect(config.maxBodyBytes).toBeGreaterThan(0);
    expect(config.orgMaxConcurrent).toBeGreaterThan(0);
    expect(config.orgMaxConcurrent).toBeLessThan(config.maxConcurrent);
  });

  it("takes execution time from the guard that actually enforces it", () => {
    const env = {};

    expect(resolveAdmissionConfig(env).maxExecutionMs).toBe(
      resolveTransactionGuards(env).statementTimeoutMs,
    );
  });

  it("follows the statement timeout when an operator changes it", () => {
    const env = { DB_STATEMENT_TIMEOUT_MS: "12000" };

    expect(resolveAdmissionConfig(env).maxExecutionMs).toBe(12_000);
  });

  it("lets an operator override every limit", () => {
    const config = resolveAdmissionConfig({
      ADMISSION_MAX_CONCURRENT: "7",
      ADMISSION_MAX_QUEUE_DEPTH: "9",
      ADMISSION_MAX_EXECUTION_MS: "1234",
      ADMISSION_MAX_BODY_BYTES: "4096",
      ADMISSION_ORG_MAX_CONCURRENT: "2",
      ADMISSION_RESERVED_FRACTION: "0.5",
    });

    expect(config).toMatchObject({
      maxConcurrent: 7,
      maxQueueDepth: 9,
      maxExecutionMs: 1234,
      maxBodyBytes: 4096,
      orgMaxConcurrent: 2,
      reservedFraction: 0.5,
    });
  });

  it("refuses a configuration it cannot parse rather than falling back silently", () => {
    expect(() => resolveAdmissionConfig({ ADMISSION_MAX_CONCURRENT: "not-a-number" })).toThrow(
      /admission/i,
    );
    expect(() => resolveAdmissionConfig({ ADMISSION_RESERVED_FRACTION: "2" })).toThrow(/admission/i);
  });
});
