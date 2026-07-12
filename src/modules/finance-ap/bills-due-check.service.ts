import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { purchaseBills, clients } from "../../db/schema";
import { CacheService } from "../../common/cache/cache.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";

const DUE_DEDUPE_KEY = (orgId: string, billId: number) => `fin:bills-due-notified:${orgId}:${billId}`;
const DUE_DEDUPE_TTL = 60 * 60 * 24;

@Injectable()
export class BillsDueCheckService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async checkBillsDue(orgId?: string): Promise<void> {
    const today = new Date();
    const threeDaysOut = new Date(today);
    threeDaysOut.setDate(today.getDate() + 3);
    const threeDaysIso = threeDaysOut.toISOString().slice(0, 10);
    const todayIso = today.toISOString().slice(0, 10);

    const conds = [
      inArray(purchaseBills.status, ["POSTED", "PARTIALLY_PAID"]),
      lte(purchaseBills.dueDate, threeDaysIso),
      gte(purchaseBills.dueDate, todayIso),
    ];

    if (orgId) {
      conds.push(eq(purchaseBills.orgId, orgId));
    }

    const due = await this.db
      .select({
        id: purchaseBills.id,
        orgId: purchaseBills.orgId,
        billNumber: purchaseBills.billNumber,
        dueDate: purchaseBills.dueDate,
        total: purchaseBills.total,
        amountPaid: purchaseBills.amountPaid,
        vendorId: purchaseBills.vendorId,
        createdBy: purchaseBills.createdBy,
        vendorName: clients.name,
      })
      .from(purchaseBills)
      .leftJoin(clients, eq(clients.id, purchaseBills.vendorId))
      .where(and(...conds));

    for (const bill of due) {
      const dedupeKey = DUE_DEDUPE_KEY(bill.orgId, bill.id);

      let alreadyNotified = false;
      try {
        const stored = await this.cache.cached<string>(dedupeKey, async () => "PENDING", DUE_DEDUPE_TTL);
        alreadyNotified = stored === "SENT";
      } catch {
        alreadyNotified = false;
      }

      if (alreadyNotified) continue;

      const outstanding = (Number(bill.total ?? 0) - Number(bill.amountPaid ?? 0)).toFixed(2);

      void this.dispatch.emit({
        eventKey: "accounting.bill.due",
        orgId: bill.orgId,
        actorUserId: null,
        targetUserIds: [bill.createdBy],
        entityType: "purchase_bill",
        entityId: String(bill.id),
        variables: {
          billNumber: bill.billNumber,
          dueDate: bill.dueDate,
          vendorName: bill.vendorName ?? `Vendor #${bill.vendorId}`,
          outstanding,
        },
      });

      await this.cache.set(dedupeKey, "SENT", DUE_DEDUPE_TTL);
    }
  }
}
