jest.mock("../../common/tenant", () => ({
  forEachOrg: async (
    _db: unknown,
    _name: string,
    fn: (tx: unknown, orgId: string) => Promise<void>,
  ) => {
    await fn({}, "org1");
    return { organizations: 1, succeeded: 1, failed: 0 };
  },
}));

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CronLeaveService } from "./cron-leave.service";
import { CronLeaveResetService } from "./cron-leave-reset.service";

const dialect = new PgDialect();
function renderSql(q: SQL): string {
  return dialect.sqlToQuery(q).sql;
}

describe("CronLeaveService – expiry VALUES cast (42804 guard)", () => {
  it(
    "emits ::integer and ::numeric casts in the VALUES rows so Postgres resolves " +
      "numeric rather than text for the new_bal column",
    async () => {
      const executedSqls: string[] = [];

      const mockTx = {
        execute: jest.fn().mockImplementation((q: SQL) => {
          executedSqls.push(renderSql(q));
          return Promise.resolve([]);
        }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
      };

      const policy = { leaveTypeId: 1, accrualRate: "1.00", orgId: "org1" };
      const balance = { id: 7, orgId: "org1", userId: "u1", leaveTypeId: 1, balance: "5.00" };

      const mockSelect = jest
        .fn()
        .mockReturnValueOnce({
          from: () => ({ where: () => ({ limit: () => Promise.resolve([policy]) }) }),
        })
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => Promise.resolve([balance]),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({
              groupBy: () => ({
                limit: () => Promise.resolve([]),
              }),
            }),
          }),
        });

      const mockDb = {
        select: mockSelect,
        transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
          cb(mockTx),
        ),
      };

      const mockReset = {
        resolveLeaveYearStartMonth: jest.fn().mockResolvedValue(13),
      };

      const mod = await Test.createTestingModule({
        providers: [
          CronLeaveService,
          { provide: DRIZZLE, useValue: mockDb },
          { provide: CronLeaveResetService, useValue: mockReset },
        ],
      }).compile();

      const service = mod.get(CronLeaveService);
      jest
        .spyOn(service, "accrueMonthlyLeaves")
        .mockResolvedValue({ accruedCount: 0, policiesTruncated: false });

      await service.runMonthlyLeaveReset();

      const updateSql = executedSqls.find(
        (s) => s.includes("leave_balances") && s.includes("new_bal"),
      );
      expect(updateSql).toBeDefined();

      expect(updateSql).toContain("::numeric");
      expect(updateSql).toContain("::integer");
    },
  );
});
