import {
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, eq, isNull, lte } from "drizzle-orm";
import { hrContracts } from "../../../db/schema/hr/global-compliance";
import { hrEmployments, hrPeople } from "../../../db/schema/hr/core-people";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { HrAuditService } from "../core/hr-audit.service";
import { HrAutomationEngineService } from "../automations/hr-automation-engine.service";
import { HrTemplatesService } from "../templates/hr-templates.service";
import { HrTemplateRenderService } from "../templates/hr-template-render.service";
import type {
  CreateContractInput,
  UpdateContractInput,
  ListContractsInput,
  EndContractInput,
  ConvertToEmployeeInput,
} from "./dto/hr-global.schemas";

@Injectable()
export class ContractsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
    private readonly hrAutomation: HrAutomationEngineService,
    private readonly templates: HrTemplatesService,
    private readonly renderService: HrTemplateRenderService,
  ) {}

  async list(orgId: string, input: ListContractsInput) {
    const { page, limit, contractType, status, days } = input;
    const offset = (page - 1) * limit;

    const conditions = [
      eq(hrContracts.orgId, orgId),
      isNull(hrContracts.deletedAt),
    ];

    if (contractType) conditions.push(eq(hrContracts.contractType, contractType));
    if (status) conditions.push(eq(hrContracts.status, status));

    if (days !== undefined) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + days);
      conditions.push(lte(hrContracts.endDate, cutoff.toISOString().split("T")[0]));
    }

    const where = and(...conditions);

    const [data, totalResult] = await Promise.all([
      this.db
        .select()
        .from(hrContracts)
        .where(where)
        .orderBy(hrContracts.endDate)
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrContracts).where(where),
    ]);

    const total = totalResult[0]?.total ?? 0;
    return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async getOne(orgId: string, contractId: number) {
    const row = await this.db.query.hrContracts.findFirst({
      where: and(
        eq(hrContracts.id, contractId),
        eq(hrContracts.orgId, orgId),
        isNull(hrContracts.deletedAt),
      ),
    });
    if (!row) throw new NotFoundException("Contract not found");
    return row;
  }

  async create(orgId: string, actorId: string, input: CreateContractInput) {
    const [created] = await this.db
      .insert(hrContracts)
      .values({
        orgId,
        employmentId: input.employmentId,
        contractType: input.contractType,
        agencyVendor: input.agencyVendor ?? null,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        renewalReminderDays: input.renewalReminderDays,
        stipendCents: input.stipendCents ?? null,
        timesheetBased: input.timesheetBased,
        status: input.status,
        documentUrl: input.documentUrl ?? null,
        createdBy: actorId,
      })
      .returning();

    if (!created) throw new Error("Failed to create contract");

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_contracts",
      entityId: String(created.id),
      action: "created",
      after: created,
    });

    return created;
  }

  async update(orgId: string, contractId: number, actorId: string, input: UpdateContractInput) {
    const existing = await this.getOne(orgId, contractId);

    const [updated] = await this.db
      .update(hrContracts)
      .set({
        ...(input.contractType !== undefined && { contractType: input.contractType }),
        ...(input.agencyVendor !== undefined && { agencyVendor: input.agencyVendor }),
        ...(input.startDate !== undefined && { startDate: input.startDate }),
        ...(input.endDate !== undefined && { endDate: input.endDate }),
        ...(input.renewalReminderDays !== undefined && { renewalReminderDays: input.renewalReminderDays }),
        ...(input.stipendCents !== undefined && { stipendCents: input.stipendCents }),
        ...(input.timesheetBased !== undefined && { timesheetBased: input.timesheetBased }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.documentUrl !== undefined && { documentUrl: input.documentUrl }),
        updatedAt: new Date(),
      })
      .where(and(eq(hrContracts.id, contractId), eq(hrContracts.orgId, orgId)))
      .returning();

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_contracts",
      entityId: String(contractId),
      action: "updated",
      before: existing,
      after: updated,
    });

    return updated;
  }

  async endContract(orgId: string, contractId: number, actorId: string, input: EndContractInput) {
    const existing = await this.getOne(orgId, contractId);

    const [updated] = await this.db
      .update(hrContracts)
      .set({ status: "ended", endDate: new Date().toISOString().split("T")[0], updatedAt: new Date() })
      .where(and(eq(hrContracts.id, contractId), eq(hrContracts.orgId, orgId)))
      .returning();

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_contracts",
      entityId: String(contractId),
      action: "ended",
      before: existing,
      after: { ...updated, notes: input.notes },
    });

    void (async () => {
      const [employment] = await this.db
        .select({ userId: hrPeople.userId })
        .from(hrEmployments)
        .innerJoin(hrPeople, eq(hrEmployments.personId, hrPeople.id))
        .where(and(eq(hrEmployments.id, existing.employmentId), eq(hrEmployments.orgId, orgId)))
        .limit(1);
      if (!employment?.userId) return;
      await this.hrAutomation.emit(orgId, "contract.ended", {
        employeeId: employment.userId,
        contractId,
        contractType: existing.contractType,
      });
    })().catch(() => undefined);

    return updated;
  }

  async convertToEmployee(orgId: string, contractId: number, actorId: string, input: ConvertToEmployeeInput) {
    const contract = await this.getOne(orgId, contractId);

    const employment = await this.db.query.hrEmployments.findFirst({
      where: and(
        eq(hrEmployments.id, contract.employmentId),
        eq(hrEmployments.orgId, orgId),
        isNull(hrEmployments.deletedAt),
      ),
    });
    if (!employment) throw new NotFoundException("Employment record not found");

    await this.db.transaction(async (tx) => {
      await tx
        .update(hrContracts)
        .set({ status: "converted", updatedAt: new Date() })
        .where(and(eq(hrContracts.id, contractId), eq(hrContracts.orgId, orgId)));

      await tx
        .update(hrEmployments)
        .set({ workerType: "FULL_TIME", updatedAt: new Date() })
        .where(and(eq(hrEmployments.id, contract.employmentId), eq(hrEmployments.orgId, orgId)));
    });

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_contracts",
      entityId: String(contractId),
      action: "converted_to_employee",
      before: { contractStatus: contract.status, workerType: employment.workerType },
      after: { contractStatus: "converted", workerType: "FULL_TIME", notes: input.notes, effectiveDate: input.effectiveDate },
    });

    return { ok: true, employmentId: contract.employmentId };
  }

  async renderInternshipCertificate(orgId: string, contractId: number, actorId: string) {
    const contract = await this.getOne(orgId, contractId);
    if (contract.contractType !== "intern") throw new NotFoundException("Contract is not an internship");

    const { data: letterTemplates } = await this.templates.list(orgId, {
      page: 1,
      limit: 10,
      kind: "letter",
      status: "active",
      search: "internship",
    });

    const listed = letterTemplates[0] ?? null;
    if (!listed) {
      return {
        html: this.buildFallbackCertificate(contract),
        templateId: null,
      };
    }

    const template = await this.templates.getById(orgId, listed.id);
    const ctx = await this.renderService.buildContext(orgId, actorId, undefined, {
      "contract.startDate": contract.startDate ?? "",
      "contract.endDate": contract.endDate ?? "",
      "contract.type": contract.contractType,
    }, false);

    const content =
      template.content && typeof template.content === "object"
        ? (template.content as Record<string, unknown>)
        : {};
    const body = typeof content.bodyHtml === "string" ? content.bodyHtml : undefined;
    const html = body ? this.renderService.renderHtml(body, ctx) : this.buildFallbackCertificate(contract);

    return { html, templateId: template.id };
  }

  private buildFallbackCertificate(contract: typeof hrContracts.$inferSelect): string {
    return `<h2>Internship Completion Certificate</h2>
<p>This is to certify that the holder successfully completed an internship engagement</p>
<p>Contract Period: ${contract.startDate ?? "N/A"} to ${contract.endDate ?? "N/A"}</p>`;
  }

  async refreshExpiredStatuses(orgId: string) {
    const today = new Date().toISOString().split("T")[0];
    const expiringCutoff = new Date();
    expiringCutoff.setDate(expiringCutoff.getDate() + 30);
    const cutoffStr = expiringCutoff.toISOString().split("T")[0];

    await this.db.transaction(async (tx) => {
      await tx
        .update(hrContracts)
        .set({ status: "ended", updatedAt: new Date() })
        .where(
          and(
            eq(hrContracts.orgId, orgId),
            eq(hrContracts.status, "active"),
            lte(hrContracts.endDate, today),
            isNull(hrContracts.deletedAt),
          ),
        );

      await tx
        .update(hrContracts)
        .set({ status: "expiring", updatedAt: new Date() })
        .where(
          and(
            eq(hrContracts.orgId, orgId),
            eq(hrContracts.status, "active"),
            lte(hrContracts.endDate, cutoffStr),
            isNull(hrContracts.deletedAt),
          ),
        );
    });
  }
}
