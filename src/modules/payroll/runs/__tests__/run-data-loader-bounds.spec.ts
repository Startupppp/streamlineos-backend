import { ConflictException } from "@nestjs/common";
import { RunDataLoaderService } from "../run-data-loader.service";
import { PAYROLL_READ_CAP } from "../../lib/query-bounds";
import { DEFAULT_PAYROLL_TOGGLES } from "../../payroll.types";
import type { Db } from "../../../../db/drizzle.types";

/**
 * The eligible-profile set is not a list — it IS the payroll.
 *
 * `loadEligibleProfiles` read active salary profiles with a bare `.limit(1000)`
 * and no ordering. A 1,200-person organisation therefore generated payroll for
 * an arbitrary 1,000 of them: the other 200 produced no `payroll_run_employees`
 * row, no line items, no exception and no warning, and
 * `run-result-persister.service.ts` then wrote the truncated count into
 * `payrollRuns.employeeCount`, so the run was internally consistent and nothing
 * anywhere reported the omission. With no `ORDER BY`, a recalculation could
 * swap which employees survived.
 *
 * `loadHeldUserIds` had the same shape with the opposite consequence: a
 * truncated hold list pays somebody the operator deliberately held back.
 *
 * Both now read one row past `PAYROLL_READ_CAP` and refuse the overflow, so an
 * organisation above the bound gets a visible 409 instead of a short payroll.
 */
function chain(data: unknown) {
  const c: Record<string, unknown> = {
    then: (resolve: (value: unknown) => void) => resolve(data),
  };
  for (const method of ["limit", "orderBy", "groupBy", "having", "offset"]) {
    c[method] = () => c;
  }
  return c;
}

function makeDb(rows: unknown[]): { db: Db; limit: jest.Mock; orderBy: jest.Mock } {
  const limit = jest.fn().mockReturnValue(chain(rows));
  const orderBy = jest.fn().mockReturnValue({ limit });
  const db = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnValue({ orderBy }),
  };
  return { db: db as unknown as Db, limit, orderBy };
}

const profileRows = (n: number): unknown[] =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    userId: `u-${i}`,
    workerId: null,
    workerType: "EMPLOYEE",
    currency: "INR",
    payoutCurrency: null,
    annualCtc: "1200000.00",
    taxRegime: "NEW",
  }));

describe("RunDataLoaderService — payroll-defining reads are bounded, not truncated", () => {
  it("probes one row past the cap so an oversized org cannot be silently short-paid", async () => {
    const { db, limit, orderBy } = makeDb(profileRows(PAYROLL_READ_CAP + 1));
    const service = new RunDataLoaderService(db);

    await expect(
      service.loadEligibleProfiles("org-1", "2026-07", { ...DEFAULT_PAYROLL_TOGGLES }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(limit).toHaveBeenCalledWith(PAYROLL_READ_CAP + 1);
    // Without an ORDER BY the surviving subset is whatever Postgres returned,
    // so a recalculation can swap which employees are in the run.
    expect(orderBy).toHaveBeenCalled();
  });

  it("returns the whole set when it fits inside the bound", async () => {
    const { db } = makeDb(profileRows(PAYROLL_READ_CAP));
    const service = new RunDataLoaderService(db);

    const profiles = await service.loadEligibleProfiles("org-1", "2026-07", {
      ...DEFAULT_PAYROLL_TOGGLES,
    });

    expect(profiles).toHaveLength(PAYROLL_READ_CAP);
  });

  it("probes the hold list too, so a held payee cannot be truncated into being paid", async () => {
    const held = Array.from({ length: PAYROLL_READ_CAP + 1 }, (_, i) => ({ userId: `u-${i}` }));
    const { db, limit } = makeDb(held);
    const service = new RunDataLoaderService(db);

    await expect(service.loadHeldUserIds("org-1", 7, ["u-0"])).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(limit).toHaveBeenCalledWith(PAYROLL_READ_CAP + 1);
  });
});
