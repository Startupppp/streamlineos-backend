import { Inject, Injectable } from "@nestjs/common";
import { and, inArray, isNotNull, lt, ne } from "drizzle-orm";
import { commandFences, invIdempotencyKeys, payrollCommandReceipts } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";

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
    const [commandFencesPruned, invKeysPruned, payrollReceiptsPruned] = await Promise.all([
      this.pruneCommandFences(now),
      this.pruneInvIdempotencyKeys(now),
      this.prunePayrollReceipts(thirtyDaysAgo),
    ]);
    return { commandFencesPruned, invKeysPruned, payrollReceiptsPruned };
  }

  private async pruneCommandFences(now: Date): Promise<number> {
    let total = 0;
    while (true) {
      const rows = await this.db
        .select({ id: commandFences.commandFenceId })
        .from(commandFences)
        .where(lt(commandFences.expiresAt, now))
        .limit(PRUNE_BATCH_SIZE);
      if (rows.length === 0) break;
      const ids = rows.map((r) => r.id);
      await this.db.delete(commandFences).where(inArray(commandFences.commandFenceId, ids));
      total += ids.length;
      if (rows.length < PRUNE_BATCH_SIZE) break;
    }
    return total;
  }

  private async pruneInvIdempotencyKeys(now: Date): Promise<number> {
    let total = 0;
    while (true) {
      const rows = await this.db
        .select({ id: invIdempotencyKeys.id })
        .from(invIdempotencyKeys)
        .where(lt(invIdempotencyKeys.expiresAt, now))
        .limit(PRUNE_BATCH_SIZE);
      if (rows.length === 0) break;
      const ids = rows.map((r) => r.id);
      await this.db.delete(invIdempotencyKeys).where(inArray(invIdempotencyKeys.id, ids));
      total += ids.length;
      if (rows.length < PRUNE_BATCH_SIZE) break;
    }
    return total;
  }

  private async prunePayrollReceipts(cutoffDate: Date): Promise<number> {
    let total = 0;
    while (true) {
      const rows = await this.db
        .select({ id: payrollCommandReceipts.id })
        .from(payrollCommandReceipts)
        .where(
          and(
            ne(payrollCommandReceipts.status, "IN_FLIGHT"),
            isNotNull(payrollCommandReceipts.finishedAt),
            lt(payrollCommandReceipts.finishedAt, cutoffDate),
          ),
        )
        .limit(PRUNE_BATCH_SIZE);
      if (rows.length === 0) break;
      const ids = rows.map((r) => r.id);
      await this.db.delete(payrollCommandReceipts).where(inArray(payrollCommandReceipts.id, ids));
      total += ids.length;
      if (rows.length < PRUNE_BATCH_SIZE) break;
    }
    return total;
  }
}
