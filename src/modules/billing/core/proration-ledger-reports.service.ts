import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, isNull, isNotNull, lt, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import { billingProrationLines } from "../../../db/schema";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

@Injectable()
export class ProrationLedgerReportsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listUnreconciled(orgId: string, limit = 100) {
    const capped = Math.min(Math.max(limit, 1), 100);
    return runInTenantTransaction(
      this.db,
      (tx) =>
        tx
          .select({
            id: billingProrationLines.id,
            idempotencyKey: billingProrationLines.idempotencyKey,
            amountMinor: billingProrationLines.amountMinor,
            providerAmountMinor: billingProrationLines.providerAmountMinor,
            providerRef: billingProrationLines.providerRef,
            currency: billingProrationLines.currency,
            effectiveFrom: billingProrationLines.effectiveFrom,
          })
          .from(billingProrationLines)
          .where(
            and(
              eq(billingProrationLines.orgId, orgId),
              isNull(billingProrationLines.reconciledAt),
              isNotNull(billingProrationLines.providerRef),
            ),
          )
          .orderBy(desc(billingProrationLines.effectiveFrom))
          .limit(capped),
      { orgId },
    );
  }

  async listForSubscription(orgId: string, subscriptionId: number, limit = 100) {
    const capped = Math.min(Math.max(limit, 1), 100);
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const lines = await tx
          .select({
            id: billingProrationLines.id,
            lineType: billingProrationLines.lineType,
            effectiveFrom: billingProrationLines.effectiveFrom,
            effectiveUntil: billingProrationLines.effectiveUntil,
            quantity: billingProrationLines.quantity,
            currency: billingProrationLines.currency,
            amountMinor: billingProrationLines.amountMinor,
            roundingRule: billingProrationLines.roundingRule,
            reconciledAt: billingProrationLines.reconciledAt,
          })
          .from(billingProrationLines)
          .where(
            and(
              eq(billingProrationLines.orgId, orgId),
              eq(billingProrationLines.subscriptionId, subscriptionId),
            ),
          )
          .orderBy(desc(billingProrationLines.effectiveFrom))
          .limit(capped);

        const chargeMinor = lines.reduce((sum, line) => sum + Math.max(line.amountMinor, 0), 0);
        const creditMinor = lines.reduce((sum, line) => sum + Math.min(line.amountMinor, 0), 0);
        return { lines, chargeMinor, creditMinor, netMinor: chargeMinor + creditMinor };
      },
      { orgId },
    );
  }

  async sumForPeriod(orgId: string, subscriptionId: number, periodStart: Date, periodEnd: Date) {
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const [row] = await tx
          .select({
            netMinor: sql<number>`COALESCE(SUM(${billingProrationLines.amountMinor}), 0)::bigint`,
            lineCount: sql<number>`COUNT(*)::int`,
          })
          .from(billingProrationLines)
          .where(
            and(
              eq(billingProrationLines.orgId, orgId),
              eq(billingProrationLines.subscriptionId, subscriptionId),
              gte(billingProrationLines.effectiveFrom, periodStart),
              lt(billingProrationLines.effectiveFrom, periodEnd),
            ),
          );
        return { netMinor: Number(row?.netMinor ?? 0), lineCount: Number(row?.lineCount ?? 0) };
      },
      { orgId },
    );
  }
}
