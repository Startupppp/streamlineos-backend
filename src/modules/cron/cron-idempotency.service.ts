import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNotNull, lt, ne } from "drizzle-orm";
import { commandFences, invIdempotencyKeys, payrollCommandReceipts } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg, type TenantTx } from "../../common/tenant";

const PRUNE_BATCH_SIZE = 500;

@Injectable()
export class CronIdempotencyService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async pruneExpiredFences(): Promise<{
    commandFencesPruned: number;
    invKeysPruned: number;
    payrollReceiptsPruned: number;
  }> {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    let commandFencesPruned = 0;
    let invKeysPruned = 0;
    let payrollReceiptsPruned = 0;

    await forEachOrg(this.db, "cron-idempotency", async (tx, orgId) => {
      commandFencesPruned += await this.pruneCommandFences(tx, orgId, now);
      invKeysPruned += await this.pruneInvIdempotencyKeys(tx, orgId, now);
      payrollReceiptsPruned += await this.prunePayrollReceipts(tx, orgId, thirtyDaysAgo);
    });

    return { commandFencesPruned, invKeysPruned, payrollReceiptsPruned };
  }

  private async pruneCommandFences(tx: TenantTx, orgId: string, now: Date): Promise<number> {
    let total = 0;
    while (true) {
      const rows = await tx
        .select({ id: commandFences.commandFenceId })
        .from(commandFences)
        .where(and(eq(commandFences.organizationId, orgId), lt(commandFences.expiresAt, now)))
        .limit(PRUNE_BATCH_SIZE);
      if (rows.length === 0) break;
      const ids = rows.map((r) => r.id);
      await tx.delete(commandFences).where(inArray(commandFences.commandFenceId, ids));
      total += ids.length;
      if (rows.length < PRUNE_BATCH_SIZE) break;
    }
    return total;
  }

  private async pruneInvIdempotencyKeys(tx: TenantTx, orgId: string, now: Date): Promise<number> {
    let total = 0;
    while (true) {
      const rows = await tx
        .select({ id: invIdempotencyKeys.id })
        .from(invIdempotencyKeys)
        .where(and(eq(invIdempotencyKeys.orgId, orgId), lt(invIdempotencyKeys.expiresAt, now)))
        .limit(PRUNE_BATCH_SIZE);
      if (rows.length === 0) break;
      const ids = rows.map((r) => r.id);
      await tx.delete(invIdempotencyKeys).where(inArray(invIdempotencyKeys.id, ids));
      total += ids.length;
      if (rows.length < PRUNE_BATCH_SIZE) break;
    }
    return total;
  }

  private async prunePayrollReceipts(tx: TenantTx, orgId: string, cutoffDate: Date): Promise<number> {
    let total = 0;
    while (true) {
      const rows = await tx
        .select({ id: payrollCommandReceipts.id })
        .from(payrollCommandReceipts)
        .where(
          and(
            eq(payrollCommandReceipts.orgId, orgId),
            ne(payrollCommandReceipts.status, "IN_FLIGHT"),
            isNotNull(payrollCommandReceipts.finishedAt),
            lt(payrollCommandReceipts.finishedAt, cutoffDate),
          ),
        )
        .limit(PRUNE_BATCH_SIZE);
      if (rows.length === 0) break;
      const ids = rows.map((r) => r.id);
      await tx.delete(payrollCommandReceipts).where(inArray(payrollCommandReceipts.id, ids));
      total += ids.length;
      if (rows.length < PRUNE_BATCH_SIZE) break;
    }
    return total;
  }
}
