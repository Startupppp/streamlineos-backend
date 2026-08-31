import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  StreamableFile,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollRuns,
  payrollRunEmployees,
  payslipPublications,
  payslipTemplates,
  organizationMembers,
  organizations,
} from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { generatePayslipPdf } from "../hr-payroll/lib/payslip-pdf";
import { buildPayslipPdfData } from "./lib/payslip-renderer";
import { loadRunEmployeePayeeById } from "../lib/payroll-run-payee";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import type { CalculationSnapshot } from "../payroll.types";
import type { PayslipTemplateConfig } from "./dto/payout.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { computeSnapshotHash } from "./payslip-bulk-publisher.service";

@Injectable()
export class PayslipDownloadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly efService: EmploymentFactsService,
  ) {}

  async downloadPdf(
    publicationId: number,
    caller: CurrentUserContext,
  ): Promise<StreamableFile> {
    const publication = await this.db.query.payslipPublications.findFirst({
      where: eq(payslipPublications.id, publicationId),
      columns: {
        id: true,
        orgId: true,
        userId: true,
        workerId: true,
        runId: true,
        runEmployeeId: true,
        snapshotHash: true,
        payslipTemplateId: true,
        status: true,
      },
    });
    if (!publication) throw new NotFoundException("Payslip publication not found");

    const isOwnPayslip =
      publication.userId != null && publication.userId === caller.userId;

    if (!isOwnPayslip) {
      if (publication.orgId !== caller.orgId) {
        throw new NotFoundException("Payslip publication not found");
      }
      const perms = await this.access.resolveUserPermissions(caller.orgId, caller.userId);
      const memberRow = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.userId, caller.userId),
          eq(organizationMembers.orgId, caller.orgId),
        ),
        columns: { isOwner: true },
      });
      const isOwner = memberRow?.isOwner === true;
      if (!isOwner && !perms.has("payroll:payslips:view")) {
        throw new ForbiddenException("Missing permission: payroll:payslips:view");
      }
    }

    const runEmployee = await this.db.query.payrollRunEmployees.findFirst({
      where: and(eq(payrollRunEmployees.id, publication.runEmployeeId), eq(payrollRunEmployees.orgId, publication.orgId)),
      columns: {
        calculationSnapshot: true,
        workerType: true,
        currency: true,
        userId: true,
        workerId: true,
      },
    });
    if (!runEmployee?.calculationSnapshot) {
      throw new ConflictException("Calculation snapshot not available for this payslip");
    }

    const payee = await loadRunEmployeePayeeById(this.db, publication.orgId, publication.runEmployeeId, this.efService);
    if (!payee) {
      throw new ConflictException("Payee details not available for this payslip");
    }

    const snapshot = runEmployee.calculationSnapshot as CalculationSnapshot;
    const currentHash = computeSnapshotHash(snapshot);
    if (publication.snapshotHash && currentHash !== publication.snapshotHash) {
      throw new ConflictException("Published payslip snapshot has changed — contact HR to re-publish");
    }

    const run = await this.db.query.payrollRuns.findFirst({
      where: and(eq(payrollRuns.id, publication.runId), eq(payrollRuns.orgId, publication.orgId)),
      columns: { month: true, orgId: true },
    });
    if (!run) throw new NotFoundException("Payroll run not found");

    const [orgRow, templateRow] = await Promise.all([
      this.db.query.organizations.findFirst({
        where: eq(organizations.id, run.orgId),
        columns: { name: true, address: true },
      }),
      publication.payslipTemplateId
        ? this.db.query.payslipTemplates.findFirst({
            where: eq(payslipTemplates.id, publication.payslipTemplateId),
            columns: { layout: true, config: true },
          })
        : Promise.resolve(null),
    ]);

    const bank = payee.bankDetails;
    const maskedAccount = bank?.accountNumber ? "XXXX" + bank.accountNumber.slice(-4) : undefined;
    const orgName = orgRow?.name ?? "Organization";
    const orgAddress = orgRow?.address
      ? [orgRow.address.city, orgRow.address.state, orgRow.address.country].filter(Boolean).join(", ")
      : undefined;

    const layout = templateRow?.layout ?? "CLASSIC";
    const rawConfig = templateRow?.config;
    const config: PayslipTemplateConfig = rawConfig && typeof rawConfig === "object"
      ? { accent: "#0f2b7f", showEmployerContributions: false, showYtd: false, ...(rawConfig as Partial<PayslipTemplateConfig>) }
      : { accent: "#0f2b7f", showEmployerContributions: false, showYtd: false };

    const pdfData = buildPayslipPdfData({
      snapshot,
      employee: {
        name: payee.displayName,
        employeeId: payee.employeeId ?? undefined,
        designation: payee.designation ?? undefined,
        joiningDate: payee.joiningDate ?? undefined,
        maskedAccount,
        bankName: bank?.bankName ?? undefined,
        ifsc: bank?.ifsc ?? undefined,
        pfUan: bank?.pfUanNumber ?? undefined,
      },
      org: { name: orgName, address: orgAddress },
      workerType: runEmployee.workerType,
      month: run.month,
      layout,
      config,
    });

    const pdfBuffer = await generatePayslipPdf(pdfData);
    return new StreamableFile(pdfBuffer, {
      type: "application/pdf",
      disposition: `attachment; filename="payslip-${run.month}.pdf"`,
    });
  }
}
