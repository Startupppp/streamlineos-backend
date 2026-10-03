import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  StreamableFile,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";

const PUBLICATION_LIST_CAP = 1_000;
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollRuns,
  payrollRunEmployees,
  payslipPublications,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { StorageService } from "../../storage/storage.service";
import { AccessService } from "../../access/access.service";
import { PayrollNotificationsService } from "../insights/payroll-notifications.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import { PayslipBulkPublisherService } from "./payslip-bulk-publisher.service";
import { PayslipDownloadService } from "./payslip-download.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PAYROLL_READ_CAP } from "../lib/query-bounds";

@Injectable()
export class PublishingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly access: AccessService,
    private readonly notifications: PayrollNotificationsService,
    private readonly dispatch: NotificationDispatchService,
    private readonly efService: EmploymentFactsService,
    private readonly publisher: PayslipBulkPublisherService,
    private readonly download: PayslipDownloadService,
  ) {}

  async publish(
    orgId: string,
    runId: number,
    actorId: string,
    subjectKeys?: string[],
    runEmployeeIds?: number[],
  ) {
    return this.publisher.publish(orgId, runId, actorId, subjectKeys, runEmployeeIds);
  }

  async releaseHold(orgId: string, runId: number, runEmployeeId: number, actorId: string) {
    const run = await this.db.query.payrollRuns.findFirst({
      where: and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)),
      columns: { id: true, status: true },
    });
    if (!run) throw new NotFoundException("Payroll run not found");
    if (run.status === "CLOSED") {
      throw new ConflictException("Cannot release a payslip on a CLOSED payroll run");
    }

    const released = await this.db
      .update(payrollRunEmployees)
      .set({ holdReason: null })
      .where(and(
        eq(payrollRunEmployees.id, runEmployeeId),
        eq(payrollRunEmployees.runId, runId),
        eq(payrollRunEmployees.orgId, orgId),
      ))
      .returning({ id: payrollRunEmployees.id });
    if (!released[0]) throw new NotFoundException("Employee record not found in this run");

    this.audit.log({
      action: "payroll.employee_unheld",
      userId: actorId,
      orgId,
      targetId: String(runEmployeeId),
      targetType: "payroll_run_employee",
      metadata: { runId, reason: null },
    });

    if (run.status === "PAID" || run.status === "PAYSLIPS_PUBLISHED") {
      return this.publisher.publish(orgId, runId, actorId, undefined, [runEmployeeId]);
    }
    return { published: 0, total: 0, heldCount: 0, runStatus: run.status };
  }

  async listPublications(orgId: string, runId: number) {
    const run = await this.db.query.payrollRuns.findFirst({
      where: and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)),
      columns: { id: true },
    });
    if (!run) throw new NotFoundException("Payroll run not found");

    const rows = await this.db.query.payslipPublications.findMany({
      where: and(eq(payslipPublications.runId, runId), eq(payslipPublications.orgId, orgId)),
      limit: PUBLICATION_LIST_CAP,
      columns: {
        id: true,
        userId: true,
        workerId: true,
        runEmployeeId: true,
        status: true,
        channel: true,
        pdfUrl: true,
        publishedAt: true,
        snapshotHash: true,
        failureReason: true,
        attemptCount: true,
        lastAttemptAt: true,
      },
    });
    return { items: rows, truncated: rows.length === PUBLICATION_LIST_CAP };
  }

  async retryFailed(
    orgId: string,
    runId: number,
    actorId: string,
  ): Promise<{ published: number; total: number; heldCount: number; runStatus: string | null; retried: number }> {
    const run = await this.db.query.payrollRuns.findFirst({
      where: and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)),
      columns: { id: true },
    });
    if (!run) throw new NotFoundException("Payroll run not found");
    const failed = await this.db.query.payslipPublications.findMany({
      where: and(
        eq(payslipPublications.runId, runId),
        eq(payslipPublications.orgId, orgId),
        eq(payslipPublications.status, "FAILED"),
      ),
      columns: { runEmployeeId: true },
      limit: PAYROLL_READ_CAP + 1,
    });
    if (failed.length === 0) {
      return { published: 0, total: 0, heldCount: 0, runStatus: null, retried: 0 };
    }
    const runEmployeeIds = failed.map((f) => f.runEmployeeId);
    const result = await this.publisher.publish(orgId, runId, actorId, undefined, runEmployeeIds);
    return { ...result, retried: runEmployeeIds.length };
  }

  async retryFailedPublication(orgId: string, publicationId: number, actorId: string) {
    const pub = await this.db.query.payslipPublications.findFirst({
      where: and(
        eq(payslipPublications.id, publicationId),
        eq(payslipPublications.orgId, orgId),
      ),
      columns: { id: true, runId: true, runEmployeeId: true, status: true },
    });
    if (!pub) throw new NotFoundException("Payslip publication not found");
    if (pub.status !== "FAILED") {
      throw new BadRequestException("Only FAILED payslip publications can be retried");
    }
    const result = await this.publisher.publish(orgId, pub.runId, actorId, undefined, [pub.runEmployeeId]);
    return { ...result, retried: 1, publicationId };
  }

  async downloadPdf(
    publicationId: number,
    caller: CurrentUserContext,
  ): Promise<StreamableFile> {
    return this.download.downloadPdf(publicationId, caller);
  }
}
