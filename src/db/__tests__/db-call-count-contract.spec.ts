import { makeCountingDb } from "./counting-db";
import type { Db } from "../drizzle.types";

jest.mock("../../common/tenant", () => {
  const actual = jest.requireActual<Record<string, unknown>>("../../common/tenant");
  return {
    ...actual,
    forEachOrg: async (
      db: unknown,
      _sweep: string,
      fn: (tx: unknown, orgId: string) => Promise<unknown>,
    ) => {
      await fn(db, "org-counting");
      return { organizations: 1, succeeded: 1, failed: 0 };
    },
  };
});

import { AiCreditsReservationService } from "../../modules/billing/core/ai-credits-reservation.service";
import { UsageMeteringService } from "../../modules/billing/core/usage-metering.service";
import { AutonomyHoldService } from "../../modules/autonomy/autonomy-hold.service";
import { CronHolidayService } from "../../modules/cron/cron-holiday.service";
import { SurveyParticipantService } from "../../modules/surveys/survey-participant.service";
import { VendorPaymentsAllocationsService } from "../../modules/finance/ap/vendor-payments-allocations.service";
import { ClientAccountsService } from "../../modules/clients/client-accounts.service";

/**
 * §5.1 box 2: no database call inside a growing loop.
 *
 * Every case here runs the same code path twice at very different row counts and
 * asserts the statement count is IDENTICAL. Asserting a small number would only
 * pin today's shape; asserting equality across N is what actually says the count
 * does not grow with the data — which is the property the contract names and the
 * one a "it returns the right rows" test cannot see.
 *
 * `makeCountingDb` counts chain roots, so a builder chain
 * (`insert().values().onConflictDoUpdate().returning()`) is one statement, which
 * is what it is on the wire.
 */

const ROW_COUNTS = [1, 50] as const;

function repeat<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_unused, index) => make(index));
}

/**
 * The string parameters a drizzle `SQL` carries, flattened.
 *
 * A batched `UPDATE … FROM (VALUES …)` puts every row's new value in the same
 * statement, so "did all five assignees get written" is a question about the
 * bindings of ONE statement rather than about how many statements ran. Recursing
 * over the whole object with a `seen` guard cannot miss a chunk class a future
 * drizzle version nests differently.
 */
function bindings(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => bindings(item, seen));
  if (typeof value !== "object" || value === null || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown; value?: unknown };
  const out: string[] = [];
  if (record.queryChunks !== undefined) out.push(...bindings(record.queryChunks, seen));
  if (Object.prototype.hasOwnProperty.call(record, "value")) out.push(...bindings(record.value, seen));
  return out;
}

describe("database call-count contract", () => {
  describe("the counter itself", () => {
    it("counts a per-row loop as one statement per row, so a real N+1 cannot pass", async () => {
      const counts: number[] = [];
      for (const rows of ROW_COUNTS) {
        const { db, statements } = makeCountingDb();
        const handle = db as { update: () => PromiseLike<unknown> };
        for (let index = 0; index < rows; index++) await handle.update();
        counts.push(statements());
      }
      expect(counts).toEqual([1, 50]);
    });

    it("counts a builder chain as exactly one statement", async () => {
      const { db, statements } = makeCountingDb({ insert: [[{ id: 1 }]] });
      type Builder = Record<string, (...args: unknown[]) => Builder> & PromiseLike<unknown>;
      const handle = db as { insert: () => Builder };
      await handle.insert().values([]).onConflictDoNothing().returning();
      expect(statements()).toBe(1);
    });
  });

  describe("AiCreditsReservationService.sweepExpiredReservations", () => {
    it("issues the same number of statements for 1 expired reservation as for 50", async () => {
      const counts: number[] = [];
      for (const rows of ROW_COUNTS) {
        const { db, statements, countOf } = makeCountingDb({
          select: [repeat(rows, (index) => ({ id: index + 1 }))],
          update: [repeat(rows, () => ({ credits: 10 })), []],
        });
        const service = new AiCreditsReservationService(db as Db);
        await expect(service.sweepExpiredReservations()).resolves.toBe(rows);
        expect(countOf("select")).toBe(1);
        counts.push(statements());
      }
      expect(counts[0]).toBe(counts[1]);
    });
  });

  describe("UsageMeteringService.sweepExpiredReservations", () => {
    it("takes one advisory lock and one claim per meter, not per reservation", async () => {
      const counts: number[] = [];
      for (const rows of ROW_COUNTS) {
        const { db, statements, countOf } = makeCountingDb({
          select: [repeat(rows, (index) => ({ id: index + 1, meterKey: "seats" }))],
          update: [repeat(rows, (index) => ({ id: index + 1 }))],
          execute: [[]],
        });
        const service = new UsageMeteringService(db as Db);
        await expect(service.sweepExpiredReservations()).resolves.toBe(rows);
        expect(countOf("execute")).toBe(1);
        expect(countOf("update")).toBe(1);
        counts.push(statements());
      }
      expect(counts[0]).toBe(counts[1]);
    });
  });

  describe("AutonomyHoldService.cancelInFlight", () => {
    it("reverses every cancelled decision in one update regardless of how many there are", async () => {
      const counts: number[] = [];
      for (const rows of ROW_COUNTS) {
        const { db, statements, countOf } = makeCountingDb({
          update: [repeat(rows, (index) => ({ decisionId: `decision-${index}` })), []],
        });
        const service = new AutonomyHoldService(
          db as Db,
          {} as ConstructorParameters<typeof AutonomyHoldService>[1],
          {} as ConstructorParameters<typeof AutonomyHoldService>[2],
          {} as ConstructorParameters<typeof AutonomyHoldService>[3],
        );
        await expect(service.cancelInFlight("org-1", "user-1", "*")).resolves.toBe(rows);
        expect(countOf("update")).toBe(2);
        counts.push(statements());
      }
      expect(counts[0]).toBe(counts[1]);
    });
  });

  describe("CronHolidayService.sendHolidayNotifications", () => {
    it("marks every holiday notified in one update regardless of how many fall tomorrow", async () => {
      const counts: number[] = [];
      for (const rows of ROW_COUNTS) {
        const { db, statements, countOf } = makeCountingDb({
          select: [repeat(rows, (index) => ({ id: index + 1 }))],
        });
        const service = new CronHolidayService(db as Db);
        await expect(service.sendHolidayNotifications()).resolves.toEqual({
          success: true,
          count: rows,
        });
        expect(countOf("update")).toBe(1);
        counts.push(statements());
      }
      expect(counts[0]).toBe(counts[1]);
    });
  });

  describe("SurveyParticipantService.import", () => {
    it("writes every participant in one insert regardless of how many were imported", async () => {
      const counts: number[] = [];
      for (const rows of ROW_COUNTS) {
        const { db, statements, countOf } = makeCountingDb({
          insert: [repeat(rows, (index) => ({ id: index + 1 }))],
        });
        const service = new SurveyParticipantService(db as Db);
        const created = await service.import("org-1", 1, {
          participants: repeat(rows, (index) => ({ email: `p${index}@example.test` })),
        } as Parameters<SurveyParticipantService["import"]>[2]);
        expect(created).toHaveLength(rows);
        expect(created.every((entry) => typeof entry.accessToken === "string")).toBe(true);
        expect(countOf("insert")).toBe(1);
        counts.push(statements());
      }
      expect(counts[0]).toBe(counts[1]);
    });
  });

  describe("VendorPaymentsAllocationsService.allocate", () => {
    it("settles every allocation in one upsert and one balance update", async () => {
      const counts: number[] = [];
      for (const rows of ROW_COUNTS) {
        const bills = repeat(rows, (index) => ({
          id: index + 1,
          status: "APPROVED",
          total: "1000.0000",
          amountPaid: "0.0000",
        }));
        const { db, statements, countOf } = makeCountingDb({
          select: [
            [{ id: 99, orgId: "org-1", amount: "1000000.0000" }],
            [{ total: "0" }],
            bills,
          ],
          insert: [[]],
          execute: [[]],
        });
        const service = new VendorPaymentsAllocationsService(db as Db, {
          log: jest.fn(),
        } as unknown as ConstructorParameters<typeof VendorPaymentsAllocationsService>[1]);

        await service.allocate("org-1", "user-1", {
          vendorPaymentId: 99,
          allocations: repeat(rows, (index) => ({ billId: index + 1, amount: 1 })),
        } as Parameters<VendorPaymentsAllocationsService["allocate"]>[2]);

        expect(countOf("insert")).toBe(1);
        expect(countOf("execute")).toBe(1);
        counts.push(statements());
      }
      expect(counts[0]).toBe(counts[1]);
    });
  });

  /*
   * The round trips here grew with the number of DISTINCT ASSIGNEES, not with the
   * number of rows, which is why five members is the interesting axis and not the
   * fifty accounts. The old shape grouped the accounts by assignee and issued one
   * `inArray` UPDATE per group, so one unassigned account cost one statement and
   * fifty spread over five members cost five. Equality across ROW_COUNTS is the
   * assertion because a small absolute number would still pass on the broken shape
   * at the low end.
   */
  describe("ClientAccountsService.runCrmAssignments", () => {
    const MEMBERS = 5;

    function harness(unassignedRows: number) {
      const members = repeat(MEMBERS, (index) => ({ userId: `cs-${index}` }));
      const counting = makeCountingDb({
        select: [
          [],
          repeat(unassignedRows, (index) => ({ id: index + 1 })),
          members.map((member) => ({ userId: member.userId, name: member.userId, image: null })),
          [],
          [{ count: 0 }],
        ],
      });
      const access = { membersWithPermission: jest.fn().mockResolvedValue(members) };
      const service = new ClientAccountsService(
        counting.db as Db,
        null,
        {} as ConstructorParameters<typeof ClientAccountsService>[2],
        {} as ConstructorParameters<typeof ClientAccountsService>[3],
        access as never,
      );
      return { ...counting, service };
    }

    it("assigns every unassigned account in one update regardless of how many assignees share them", async () => {
      const counts: number[] = [];
      for (const rows of ROW_COUNTS) {
        const { service, statements, countOf } = harness(rows);
        await service.runCrmAssignments("org-1");
        expect(countOf("update")).toBe(0);
        expect(countOf("execute")).toBe(1);
        counts.push(statements());
      }
      expect(counts[0]).toBe(counts[1]);
    });

    it("spreads the accounts across every member, so the fixture really does exercise many assignees", async () => {
      const { service, db } = harness(50);
      const executor = db as { execute: (statement: unknown) => unknown };
      const seen: string[] = [];
      const original = executor.execute;
      executor.execute = (statement: unknown) => {
        seen.push(...bindings(statement));
        return original(statement);
      };

      await service.runCrmAssignments("org-1");

      for (let index = 0; index < MEMBERS; index++) expect(seen).toContain(`cs-${String(index)}`);
    });
  });
});
