import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { forEachOrg } from "../../../common/tenant";
import { StorageService } from "../../storage/storage.service";
import { PayrollRunExportService, type PayrollRunExportJobRow } from "./payroll-export.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";

const EXPORT_HEADERS = ["Month", "Run Type", "Status", "Employees", "Gross Total", "Net Total", "Exceptions", "Created At"] as const;

@Injectable()
export class PayrollRunExportWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PayrollRunExportWorkerService.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly jobs: PayrollRunExportService,
    private readonly storage: StorageService,
  ) {}

  onModuleInit() {
    if (process.env.PAYROLL_EXPORT_WORKER_ENABLED !== "false") {
      this.timer = setInterval(() => void this.tick(), 30000);
      this.timer.unref();
      void this.tick();
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  wake() {
    void this.tick();
  }

  private async tick() {
    if (this.running || !this.storage.isConfigured()) return;
    this.running = true;
    try {
      await forEachOrg(this.db, "payroll-export-worker", async (_tx, orgId) => {
        const job = await this.jobs.claim(orgId);
        if (job) await this.process(job);
      });
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.running = false;
    }
  }

  private async process(job: PayrollRunExportJobRow) {
    try {
      const lines = [EXPORT_HEADERS.join(",")];
      let afterId: number | undefined;
      let count = 0;
      for (;;) {
        const rows = await this.jobs.rows(job, afterId);
        if (!rows.length) break;
        for (const row of rows) {
          const vals = [
            row.month,
            row.runType,
            row.status,
            String(row.employeeCount ?? 0),
            row.grossTotal ?? "0",
            row.netTotal ?? "0",
            String(row.exceptionCount ?? 0),
            row.createdAt.toISOString(),
          ].map((v) => `"${String(v).replace(/"/g, '""')}"`);
          lines.push(vals.join(","));
          afterId = row.id;
          count++;
        }
        await this.jobs.progress(job.id, count);
        if (rows.length < 500) break;
      }
      const result = await this.storage.uploadFile(
        job.orgId,
        Buffer.from(lines.join("\n"), "utf8"),
        "payroll-exports",
        `payroll-runs-${job.id}.csv`,
        "text/csv",
      );
      await this.jobs.complete(
        job.id,
        result.key,
        `payroll-runs-${job.createdAt.toISOString().slice(0, 10)}.csv`,
        result.size,
        count,
      );
    } catch (error) {
      await this.jobs.fail(job, error);
    }
  }
}
