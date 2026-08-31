import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { forEachOrg } from "../../common/tenant";
import { StorageService } from "../storage/storage.service";
import { ExpenseExportService, type ExpenseExportJobRow, EXPORT_BATCH_SIZE } from "./expense-export.service";
import { Inject } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";

const EXPORT_ROW_CAP = 50_000;

@Injectable()
export class ExpenseExportWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExpenseExportWorkerService.name); private timer: ReturnType<typeof setInterval> | undefined; private running = false;
  constructor(@Inject(DRIZZLE) private readonly db: Db, private readonly jobs: ExpenseExportService, private readonly storage: StorageService) {}
  onModuleInit() { if (process.env.EXPENSE_EXPORT_WORKER_ENABLED !== "false") { this.timer = setInterval(() => void this.tick(), 30000); this.timer.unref(); void this.tick(); } }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  wake() { void this.tick(); }
  private async tick() { if (this.running || !this.storage.isConfigured()) return; this.running = true; try { await forEachOrg(this.db, "expense-export-worker", async (_tx, orgId) => { const job = await this.jobs.claim(orgId); if (job) await this.process(job); }); } catch (error) { this.logger.error(error instanceof Error ? error.message : String(error)); } finally { this.running = false; } }
  private async process(job: ExpenseExportJobRow) {
    try {
      const lines = ['Date,Employee,Email,Category,Amount,Description,Status,Rejection Reason'];
      let after: number | undefined;
      let count = 0;
      let truncated = false;
      for (;;) {
        const rows = await this.jobs.rows(job, after);
        if (!rows.length) break;
        for (const row of rows) {
          const vals = [row.date, row.employee ?? "", row.email ?? "", row.category, row.amount, row.description ?? "", row.status, row.rejection ?? ""].map((v) => `"${String(v).replace(/"/g, '""')}"`);
          lines.push(vals.join(","));
          after = row.id;
          count++;
          if (count >= EXPORT_ROW_CAP) { truncated = true; break; }
        }
        await this.jobs.progress(job.id, count);
        if (truncated || rows.length < EXPORT_BATCH_SIZE) break;
      }
      const result = await this.storage.uploadFile(job.orgId, Buffer.from(lines.join("\n"), "utf8"), "expense-exports", `expenses-${job.id}.csv`, "text/csv");
      await this.jobs.complete(job.id, result.key, `expenses-${job.createdAt.toISOString().slice(0, 10)}.csv`, result.size, count, truncated);
    } catch (error) { await this.jobs.fail(job, error); }
  }
}
