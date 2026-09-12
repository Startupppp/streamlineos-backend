import { RETENTION_JOBS } from "../retention-schedule";
import { PLAN_PRICES_PAISE } from "../../billing/core/plan-entitlements.constants";

describe("billing lifecycle scheduling — retention schedule registration", () => {
  it("declares a period-expiry job in RETENTION_JOBS", () => {
    const job = RETENTION_JOBS.find((j) => j.jobKey === "period-expiry");
    expect(job).toBeDefined();
  });

  it("period-expiry runs daily with a 26-hour staleness gate", () => {
    const job = RETENTION_JOBS.find((j) => j.jobKey === "period-expiry");
    expect(job?.intervalMs).toBe(24 * 3_600_000);
    expect(job?.maxAgeMs).toBe(26 * 3_600_000);
  });

  it("declares a trial-expiry job in RETENTION_JOBS", () => {
    expect(RETENTION_JOBS.some((j) => j.jobKey === "trial-expiry")).toBe(true);
  });

  it("declares a monthly-plan-grants job in RETENTION_JOBS", () => {
    expect(RETENTION_JOBS.some((j) => j.jobKey === "monthly-plan-grants")).toBe(true);
  });
});

describe("billing lifecycle scheduling — PLAN_PRICES_PAISE completeness", () => {
  it("has a price for every paid plan so period-expiry can emit MRR-bearing churn events", () => {
    expect(PLAN_PRICES_PAISE.STARTER).toBeGreaterThan(0);
    expect(PLAN_PRICES_PAISE.PROFESSIONAL).toBeGreaterThan(0);
    expect(PLAN_PRICES_PAISE.ENTERPRISE).toBeGreaterThan(0);
  });
});
