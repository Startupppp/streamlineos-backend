import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  finPaymentRuns,
  finPaymentRunItems,
  purchaseBills,
  vendorPayments,
  clients,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { decodeCursor, buildCursorPage } from "../../../common/pagination/cursor";
import { keysetBefore } from "../../../common/pagination/keyset";
import { checkApprovalPolicy } from "./ap-approval.helper";
import { assertOrganizationActor } from "../../../common/organization/organization-actor";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type {
  CreatePaymentRunInput,
  UpdatePaymentRunItemInput,
  ListPaymentRunsQuery,
} from "./dto/finance-ap.schemas";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const PAYMENT_RUN_CACHE_KEY = (orgId: string) => `fin:payment-runs:${orgId}`;

@Injectable()
export class PaymentRunsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async listRuns(orgId: string, query: ListPaymentRunsQuery) {
    const { cursor, limit, status } = query;
    const pos = decodeCursor(cursor);
    const pageLimit = Math.min(limit, 100);

    const conds = [eq(finPaymentRuns.orgId, orgId)];
    if (status) conds.push(eq(finPaymentRuns.status, status));
    if (pos) conds.push(keysetBefore(finPaymentRuns.createdAt, finPaymentRuns.id, pos));

    const rows = await this.db
      .select({
        id: finPaymentRuns.id,
        orgId: finPaymentRuns.orgId,
        name: finPaymentRuns.name,
        scheduledDate: finPaymentRuns.scheduledDate,
        status: finPaymentRuns.status,
        totalAmount: finPaymentRuns.totalAmount,
        approvedBy: finPaymentRuns.approvedBy,
        approvedAt: finPaymentRuns.approvedAt,
        createdBy: finPaymentRuns.createdBy,
        createdAt: finPaymentRuns.createdAt,
        updatedAt: finPaymentRuns.updatedAt,
        itemCount: sql<number>`count(${finPaymentRunItems.id})::int`,
      })
      .from(finPaymentRuns)
      .leftJoin(finPaymentRunItems, eq(finPaymentRunItems.runId, finPaymentRuns.id))
      .where(and(...conds))
      .groupBy(finPaymentRuns.id)
      .orderBy(desc(finPaymentRuns.createdAt), desc(finPaymentRuns.id))
      .limit(pageLimit + 1);

    return buildCursorPage(rows, pageLimit, (row) => ({
      sortValue: (row.createdAt ?? new Date(0)).toISOString(),
      id: String(row.id),
    }));
  }

  async getRun(orgId: string, runId: number) {
    const rows = await this.db
      .select()
      .from(finPaymentRuns)
      .where(and(eq(finPaymentRuns.id, runId), eq(finPaymentRuns.orgId, orgId)))
      .limit(1);

    const run = rows[0];
    if (!run) throw new NotFoundException("Payment run not found");

    const items = await this.db
      .select({
        id: finPaymentRunItems.id,
        runId: finPaymentRunItems.runId,
        billId: finPaymentRunItems.billId,
        billNumber: purchaseBills.billNumber,
        vendorId: finPaymentRunItems.vendorId,
        vendorName: clients.name,
        amount: finPaymentRunItems.amount,
        status: finPaymentRunItems.status,
        vendorPaymentId: finPaymentRunItems.vendorPaymentId,
        dueDate: purchaseBills.dueDate,
      })
      .from(finPaymentRunItems)
      .leftJoin(purchaseBills, eq(purchaseBills.id, finPaymentRunItems.billId))
      .leftJoin(clients, eq(clients.id, finPaymentRunItems.vendorId))
      .where(and(eq(finPaymentRunItems.orgId, orgId), eq(finPaymentRunItems.runId, runId)));

    return { ...run, items };
  }

  async createRun(orgId: string, userId: string, input: CreatePaymentRunInput) {
    await assertOrganizationActor(this.db, orgId, { kind: "user", userId });
    const conds = [
      eq(purchaseBills.orgId, orgId),
      inArray(purchaseBills.status, ["POSTED", "PARTIALLY_PAID"]),
      gt(
        sql<number>`(${purchaseBills.total}::numeric - ${purchaseBills.amountPaid}::numeric)`,
        sql<number>`0.005`,
      ),
    ];

    if (input.filters?.vendorIds?.length)
      conds.push(inArray(purchaseBills.vendorId, input.filters.vendorIds));
    if (input.filters?.dueBefore)
      conds.push(lte(purchaseBills.dueDate, input.filters.dueBefore));
    if (input.filters?.minAmount !== undefined) {
      const minAmt = input.filters.minAmount;
      conds.push(
        gt(
          sql<number>`(${purchaseBills.total}::numeric - ${purchaseBills.amountPaid}::numeric)`,
          sql<number>`${minAmt}`,
        ),
      );
    }

    const matchingBills = await this.db
      .select({
        id: purchaseBills.id,
        vendorId: purchaseBills.vendorId,
        total: purchaseBills.total,
        amountPaid: purchaseBills.amountPaid,
      })
      .from(purchaseBills)
      .where(and(...conds));

    const filteredBills = matchingBills.filter((b) => {
      const outstanding = round2(Number(b.total ?? 0) - Number(b.amountPaid ?? 0));
      if (input.filters?.maxAmount !== undefined && outstanding > input.filters.maxAmount)
        return false;
      return outstanding > 0.005;
    });

    if (filteredBills.length === 0)
      throw new BadRequestException("No outstanding bills match the provided filters");

    const totalAmount = round2(
      filteredBills.reduce(
        (acc, b) => acc + round2(Number(b.total ?? 0) - Number(b.amountPaid ?? 0)),
        0,
      ),
    );

    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .insert(finPaymentRuns)
        .values({
          orgId,
          name: input.name,
          scheduledDate: input.scheduledDate ?? null,
          status: "DRAFT",
          totalAmount: totalAmount.toFixed(4),
          createdBy: userId,
        })
        .returning();

      if (!run) throw new Error("Payment run insert returned no rows");

      await tx.insert(finPaymentRunItems).values(
        filteredBills.map((b) => ({
          orgId,
          runId: run.id,
          billId: b.id,
          vendorId: b.vendorId ?? null,
          amount: round2(Number(b.total ?? 0) - Number(b.amountPaid ?? 0)).toFixed(4),
          status: "PENDING" as const,
        })),
      );

      return run;
    });
  }

  async approveRun(u: CurrentUserContext, runId: number) {
    const { orgId, userId } = u;
    await assertOrganizationActor(this.db, orgId, { kind: "user", userId });

    const rows = await this.db
      .select()
      .from(finPaymentRuns)
      .where(and(eq(finPaymentRuns.id, runId), eq(finPaymentRuns.orgId, orgId)))
      .limit(1);
    const run = rows[0];
    if (!run) throw new NotFoundException("Payment run not found");
    if (run.status !== "DRAFT")
      throw new ConflictException(
        `Payment run is in status ${run.status}; only DRAFT runs can be approved`,
      );

    const total = Number(run.totalAmount ?? 0);
    const check = await checkApprovalPolicy(this.db, orgId, "VENDOR_PAYMENT", total);

    if (check.needsApproval && check.approverUserId && check.approverUserId !== userId) {
      await this.dispatch.emit({
        eventKey: "accounting.bill.approval_requested",
        orgId,
        actorUserId: userId,
        targetUserIds: [check.approverUserId],
        entityType: "payment_run",
        entityId: String(runId),
        variables: { runName: run.name, total },
      });
    }

    const [updated] = await this.db
      .update(finPaymentRuns)
      .set({
        status: "APPROVED",
        approvedBy: userId,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(finPaymentRuns.id, runId), eq(finPaymentRuns.orgId, orgId)))
      .returning();

    await this.cache.invalidate(PAYMENT_RUN_CACHE_KEY(orgId));

    this.audit.log({
      action: "accounting.payment_run.approve",
      userId,
      orgId,
      resourceType: "payment_run",
      resourceId: String(runId),
      result: "SUCCESS",
    });

    return updated;
  }

  async cancelRun(orgId: string, userId: string, runId: number) {
    const rows = await this.db
      .select()
      .from(finPaymentRuns)
      .where(and(eq(finPaymentRuns.id, runId), eq(finPaymentRuns.orgId, orgId)))
      .limit(1);
    const run = rows[0];
    if (!run) throw new NotFoundException("Payment run not found");
    if (run.status === "COMPLETED" || run.status === "CANCELLED")
      throw new ConflictException(`Payment run is already ${run.status}`);

    await this.db
      .update(finPaymentRuns)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(and(eq(finPaymentRuns.id, runId), eq(finPaymentRuns.orgId, orgId)));

    await this.cache.invalidate(PAYMENT_RUN_CACHE_KEY(orgId));

    this.audit.log({
      action: "accounting.payment_run.cancel",
      userId,
      orgId,
      resourceType: "payment_run",
      resourceId: String(runId),
      result: "SUCCESS",
    });

    return { id: runId, status: "CANCELLED" };
  }

  async updateRunItem(
    orgId: string,
    userId: string,
    runId: number,
    itemId: number,
    input: UpdatePaymentRunItemInput,
  ) {
    const runRows = await this.db
      .select({ status: finPaymentRuns.status })
      .from(finPaymentRuns)
      .where(and(eq(finPaymentRuns.id, runId), eq(finPaymentRuns.orgId, orgId)))
      .limit(1);
    const run = runRows[0];
    if (!run) throw new NotFoundException("Payment run not found");
    if (run.status !== "DRAFT")
      throw new ConflictException("Items can only be modified while the run is in DRAFT status");

    const itemRows = await this.db
      .select()
      .from(finPaymentRunItems)
      .where(
        and(
          eq(finPaymentRunItems.orgId, orgId),
          eq(finPaymentRunItems.id, itemId),
          eq(finPaymentRunItems.runId, runId),
        ),
      )
      .limit(1);
    const item = itemRows[0];
    if (!item) throw new NotFoundException("Payment run item not found");

    if (input.excluded === true) {
      await this.db
        .delete(finPaymentRunItems)
        .where(
          and(
            eq(finPaymentRunItems.orgId, orgId),
            eq(finPaymentRunItems.id, itemId),
            eq(finPaymentRunItems.runId, runId),
          ),
        );
    } else if (input.amount !== undefined) {
      const billRows = await this.db
        .select({ total: purchaseBills.total, amountPaid: purchaseBills.amountPaid })
        .from(purchaseBills)
        .where(and(eq(purchaseBills.id, item.billId), eq(purchaseBills.orgId, orgId)))
        .limit(1);
      const bill = billRows[0];
      if (bill) {
        const outstanding = round2(Number(bill.total ?? 0) - Number(bill.amountPaid ?? 0));
        if (input.amount > outstanding + 0.005)
          throw new BadRequestException(
            `Amount ${input.amount.toFixed(2)} exceeds bill outstanding ${outstanding.toFixed(2)}`,
          );
      }

      await this.db
        .update(finPaymentRunItems)
        .set({ amount: input.amount.toFixed(4) })
        .where(
          and(
            eq(finPaymentRunItems.orgId, orgId),
            eq(finPaymentRunItems.id, itemId),
            eq(finPaymentRunItems.runId, runId),
          ),
        );

      const itemTotals = await this.db
        .select({
          total: sql<string>`COALESCE(sum(${finPaymentRunItems.amount}::numeric), 0)::text`,
        })
        .from(finPaymentRunItems)
        .where(and(eq(finPaymentRunItems.orgId, orgId), eq(finPaymentRunItems.runId, runId)));

      const newTotal = round2(Number(itemTotals[0]?.total ?? 0));
      await this.db
        .update(finPaymentRuns)
        .set({ totalAmount: newTotal.toFixed(4), updatedAt: new Date() })
        .where(and(eq(finPaymentRuns.id, runId), eq(finPaymentRuns.orgId, orgId)));
    }

    this.audit.log({
      action: "accounting.payment_run.update_item",
      userId,
      orgId,
      resourceType: "payment_run_item",
      resourceId: String(itemId),
      metadata: { runId, input },
      result: "SUCCESS",
    });

    return { id: itemId, updated: true };
  }
}
