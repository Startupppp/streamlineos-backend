import { isSQLWrapper, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { PayrollJobsService } from "./payroll-jobs.service";
import type { Db } from "../../../db/drizzle.module";

/**
 * `claimPending` ran one `UPDATE … RETURNING` per candidate row, so a worker claiming a
 * batch of ten paid ten round trips and the cost grew with the queue (ticket 21 box 1 /
 * box 3).
 *
 * It also computed `attempt` in JavaScript from the value the candidate SELECT had read.
 * Between the SELECT and that UPDATE another worker can claim, run and re-enqueue the
 * same job; the write then puts the stale count back, so the retry ceiling
 * (`fail()` compares `attempt >= maxAttempts`) silently never arrives and a poisoned job
 * loops instead of dead-lettering. The increment belongs in SQL.
 */

interface Captured {
  updateCalls: number;
  setValues: Record<string, unknown>[];
}

function renderSql(fragment: unknown): string {
  if (!isSQLWrapper(fragment)) return "";
  return new PgDialect().sqlToQuery(fragment.getSQL() as SQL).sql;
}

function makeDb(
  pending: { id: number; attempt?: number }[],
  returning: Record<string, unknown>[],
) {
  const capture: Captured = { updateCalls: 0, setValues: [] };

  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(pending),
          }),
        }),
      }),
    }),
    update: jest.fn().mockImplementation(() => {
      capture.updateCalls += 1;
      return {
        set: jest.fn().mockImplementation((values: Record<string, unknown>) => {
          capture.setValues.push(values);
          return {
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue(returning),
            }),
          };
        }),
      };
    }),
  };

  return { service: new PayrollJobsService(db as unknown as Db), capture };
}

describe("PayrollJobsService.claimPending", () => {
  it("claims the whole batch in ONE update, not one round trip per candidate", async () => {
    const { service, capture } = makeDb(
      [{ id: 1 }, { id: 2 }, { id: 3 }],
      [{ id: 1 }, { id: 2 }, { id: 3 }],
    );

    const claimed = await service.claimPending(3);

    expect(capture.updateCalls).toBe(1);
    expect(claimed).toHaveLength(3);
  });

  it("increments attempt in SQL against the stored column, never from the value it read", async () => {
    const { service, capture } = makeDb([{ id: 1, attempt: 0 }], [{ id: 1 }]);

    await service.claimPending(1);

    const attempt = capture.setValues[0]?.attempt;
    expect(typeof attempt).not.toBe("number");
    expect(renderSql(attempt).toLowerCase()).toContain("coalesce");
    expect(renderSql(attempt)).toContain("attempt");
  });

  it("restores the FIFO order of the candidate select when RETURNING comes back shuffled", async () => {
    const { service } = makeDb(
      [{ id: 7 }, { id: 8 }, { id: 9 }],
      [{ id: 9 }, { id: 7 }, { id: 8 }],
    );

    const claimed = await service.claimPending(3);

    expect(claimed.map((job) => job.id)).toEqual([7, 8, 9]);
  });

  it("issues no update at all when nothing is pending", async () => {
    const { service, capture } = makeDb([], []);

    expect(await service.claimPending(5)).toEqual([]);
    expect(capture.updateCalls).toBe(0);
  });
});
