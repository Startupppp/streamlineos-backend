import { resolveTransactionGuards } from "../../db/pool.config";
import { resolveAdmissionConfig } from "./admission.config";

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
