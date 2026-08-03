import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, lte, sql, sum } from "drizzle-orm";
import { hrLeaveLedger, leaveRequests, leaveTypes } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { hrLeaveTxnTypeEnum, hrLeaveLedgerSourceEnum } from "../../../db/schema/hr/leave-ledger";

type TxnType = typeof hrLeaveTxnTypeEnum.enumValues[number];
type LedgerSource = typeof hrLeaveLedgerSourceEnum.enumValues[number];

const CREDIT_TYPES: ReadonlySet<TxnType> = new Set([
  "accrual",
  "adjustment",
  "carry_forward",
  "comp_off_earn",
  "reversal",
]);

export interface LedgerWriteInput {
  orgId: string;
  userId: string;
  leaveTypeId: number;
  txnType: TxnType;
  days: number;
  effectiveDate: string;
  period?: string;
  source: LedgerSource;
  sourceId?: string;
  note?: string;
  createdBy?: string;
}

export interface LeaveSummaryRow {
  userId: string;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  halfDayCount: number;
  hourlyLeaveHours: number;
  compOffUsed: number;
  encashmentDays: number;
}

@Injectable()
export class LeaveLedgerService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private static readonly DEBIT_TYPES: ReadonlySet<TxnType> = new Set<TxnType>([
    "consumption",
    "encashment",
    "comp_off_use",
  ]);

  async write(input: LedgerWriteInput, tx?: Db): Promise<void> {
    const db = tx ?? this.db;
    const isLocked = LeaveLedgerService.DEBIT_TYPES.has(input.txnType)
      ? await this.isPeriodLocked(input.orgId, input.userId, input.leaveTypeId, input.effectiveDate, db)
      : false;
    if (isLocked) {
      await db.insert(hrLeaveLedger).values({
        orgId: input.orgId,
        userId: input.userId,
        leaveTypeId: input.leaveTypeId,
        txnType: "adjustment",
        days: String(input.days),
        effectiveDate: input.effectiveDate,
        period: input.period,
        source: input.source,
        sourceId: input.sourceId,
        note: input.note ? `[post-cutoff] ${input.note}` : "[post-cutoff adjustment]",
        payrollStatus: "pending",
        createdBy: input.createdBy,
      });
      return;
    }
    await db.insert(hrLeaveLedger).values({
      orgId: input.orgId,
      userId: input.userId,
      leaveTypeId: input.leaveTypeId,
      txnType: input.txnType,
      days: String(input.days),
      effectiveDate: input.effectiveDate,
      period: input.period,
      source: input.source,
      sourceId: input.sourceId,
      note: input.note,
      payrollStatus: "pending",
      createdBy: input.createdBy,
    });
  }

  async balanceFromLedger(orgId: string, userId: string, leaveTypeId: number): Promise<number> {
    const rows = await this.db
      .select({
        txnType: hrLeaveLedger.txnType,
        total: sum(hrLeaveLedger.days),
      })
      .from(hrLeaveLedger)
      .where(
        and(
          eq(hrLeaveLedger.orgId, orgId),
          eq(hrLeaveLedger.userId, userId),
          eq(hrLeaveLedger.leaveTypeId, leaveTypeId),
        ),
      )
      .groupBy(hrLeaveLedger.txnType);

    let balance = 0;
    for (const row of rows) {
      const amt = Number(row.total ?? 0);
      if (CREDIT_TYPES.has(row.txnType as TxnType)) {
        balance += amt;
      } else {
        balance -= amt;
      }
    }
    return Math.max(0, balance);
  }

  async buildLeaveSummary(
    orgId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<LeaveSummaryRow[]> {
    const [ledgerRows, requestRows] = await Promise.all([
      this.db
        .select({
          userId: hrLeaveLedger.userId,
          txnType: hrLeaveLedger.txnType,
          totalDays: sum(hrLeaveLedger.days),
        })
        .from(hrLeaveLedger)
        .where(
          and(
            eq(hrLeaveLedger.orgId, orgId),
            gte(hrLeaveLedger.effectiveDate, periodStart),
            lte(hrLeaveLedger.effectiveDate, periodEnd),
          ),
        )
        .groupBy(hrLeaveLedger.userId, hrLeaveLedger.txnType),

      this.db
        .select({
          userId: leaveRequests.userId,
          leaveTypeId: leaveRequests.leaveTypeId,
          lopDays: sum(leaveRequests.lopDays),
          halfDayCount: sql<number>`SUM(CASE WHEN ${leaveRequests.isHalfDay} THEN 1 ELSE 0 END)`.mapWith(Number),
          leaveTypeName: leaveTypes.name,
        })
        .from(leaveRequests)
        .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
        .where(
          and(
            eq(leaveRequests.orgId, orgId),
            eq(leaveRequests.status, "APPROVED"),
            gte(leaveRequests.startDate, periodStart),
            lte(leaveRequests.endDate, periodEnd),
          ),
        )
        .groupBy(leaveRequests.userId, leaveRequests.leaveTypeId, leaveTypes.name),
    ]);

    const byUser = new Map<string, LeaveSummaryRow>();

    const ensureUser = (userId: string): LeaveSummaryRow => {
      if (!byUser.has(userId)) {
        byUser.set(userId, {
          userId,
          paidLeaveDays: 0,
          unpaidLeaveDays: 0,
          halfDayCount: 0,
          hourlyLeaveHours: 0,
          compOffUsed: 0,
          encashmentDays: 0,
        });
      }
      return byUser.get(userId)!;
    };

    for (const row of ledgerRows) {
      const entry = ensureUser(row.userId);
      const amt = Number(row.totalDays ?? 0);
      switch (row.txnType as TxnType) {
        case "consumption":
          entry.paidLeaveDays += amt;
          break;
        case "comp_off_use":
          entry.compOffUsed += amt;
          break;
        case "encashment":
          entry.encashmentDays += amt;
          break;
        default:
          break;
      }
    }

    for (const row of requestRows) {
      const entry = ensureUser(row.userId);
      const lopAmt = Number(row.lopDays ?? 0);
      if (lopAmt > 0) {
        entry.paidLeaveDays = Math.max(0, entry.paidLeaveDays - lopAmt);
        entry.unpaidLeaveDays += lopAmt;
      }
      entry.halfDayCount += row.halfDayCount;
    }

    return Array.from(byUser.values());
  }

  private async isPeriodLocked(
    orgId: string,
    userId: string,
    leaveTypeId: number,
    effectiveDate: string,
    db: Db,
  ): Promise<boolean> {
    const yearMonth = effectiveDate.slice(0, 7);
    const periodStart = `${yearMonth}-01`;
    const periodEnd = `${yearMonth}-31`;

    const lockedRow = await db.query.hrLeaveLedger.findFirst({
      where: and(
        eq(hrLeaveLedger.orgId, orgId),
        eq(hrLeaveLedger.userId, userId),
        eq(hrLeaveLedger.leaveTypeId, leaveTypeId),
        gte(hrLeaveLedger.effectiveDate, periodStart),
        lte(hrLeaveLedger.effectiveDate, periodEnd),
        eq(hrLeaveLedger.payrollStatus, "locked"),
      ),
      columns: { id: true },
    });

    return lockedRow !== undefined;
  }
}
