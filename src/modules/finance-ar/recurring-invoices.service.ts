import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { finRecurringInvoiceTemplates } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { InvoicesWriteService } from "../invoices/invoices-write.service";
import { buildListResponse, paginateOffset } from "../../common/pagination/pagination";
import { logger } from "../../common/logger/logger.service";
import type { CreateRecurringTemplateInput, UpdateRecurringTemplateInput, ListRecurringTemplatesQuery } from "./dto/finance-ar.schemas";
import { createInvoiceSchema } from "../invoices/dto/invoice-write.schemas";

type Frequency = "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY";

function advanceByFrequency(fromIso: string, frequency: Frequency): string {
  const d = new Date(`${fromIso}T00:00:00.000Z`);
  switch (frequency) {
    case "DAILY": d.setUTCDate(d.getUTCDate() + 1); break;
    case "WEEKLY": d.setUTCDate(d.getUTCDate() + 7); break;
    case "MONTHLY": d.setUTCMonth(d.getUTCMonth() + 1); break;
    case "QUARTERLY": d.setUTCMonth(d.getUTCMonth() + 3); break;
    case "YEARLY": d.setUTCFullYear(d.getUTCFullYear() + 1); break;
  }
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class RecurringInvoicesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly invoicesWrite: InvoicesWriteService,
    private readonly dispatch: NotificationDispatchService,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string, query: ListRecurringTemplatesQuery) {
    const { limit, offset } = paginateOffset(query);
    const conditions = [eq(finRecurringInvoiceTemplates.orgId, orgId)];
    if (query.isActive !== undefined) conditions.push(eq(finRecurringInvoiceTemplates.isActive, query.isActive));

    const [rows, [{ count }]] = await Promise.all([
      this.db.select().from(finRecurringInvoiceTemplates).where(and(...conditions)).orderBy(desc(finRecurringInvoiceTemplates.createdAt)).limit(limit).offset(offset),
      this.db.select({ count: sql<number>`count(*)::int` }).from(finRecurringInvoiceTemplates).where(and(...conditions)),
    ]);
    return buildListResponse(rows, count, query);
  }

  async get(orgId: string, id: number) {
    const tpl = await this.db.query.finRecurringInvoiceTemplates.findFirst({
      where: and(eq(finRecurringInvoiceTemplates.id, id), eq(finRecurringInvoiceTemplates.orgId, orgId)),
    });
    if (!tpl) throw new NotFoundException("Recurring template not found");
    return tpl;
  }

  async create(orgId: string, userId: string, input: CreateRecurringTemplateInput) {
    const [tpl] = await this.db
      .insert(finRecurringInvoiceTemplates)
      .values({
        orgId,
        name: input.name,
        clientId: input.clientId ?? null,
        frequency: input.frequency,
        nextRunDate: input.nextRunDate ?? null,
        endDate: input.endDate ?? null,
        payload: input.payload,
        createdBy: userId,
      })
      .returning();
    if (!tpl) throw new Error("Template insert returned no rows");
    this.audit.log({ action: "recurring_invoice.create", userId, orgId, resourceType: "recurring_invoice_template", resourceId: String(tpl.id) });
    return tpl;
  }

  async update(orgId: string, userId: string, id: number, input: UpdateRecurringTemplateInput) {
    const tpl = await this.get(orgId, id);
    const [updated] = await this.db
      .update(finRecurringInvoiceTemplates)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
        ...(input.frequency !== undefined ? { frequency: input.frequency } : {}),
        ...(input.nextRunDate !== undefined ? { nextRunDate: input.nextRunDate } : {}),
        ...(input.endDate !== undefined ? { endDate: input.endDate } : {}),
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(finRecurringInvoiceTemplates.id, id), eq(finRecurringInvoiceTemplates.orgId, orgId)))
      .returning();
    this.audit.log({ action: "recurring_invoice.update", userId, orgId, resourceType: "recurring_invoice_template", resourceId: String(tpl.id) });
    return updated;
  }

  async delete(orgId: string, userId: string, id: number) {
    await this.get(orgId, id);
    await this.db.delete(finRecurringInvoiceTemplates).where(and(eq(finRecurringInvoiceTemplates.id, id), eq(finRecurringInvoiceTemplates.orgId, orgId)));
    this.audit.log({ action: "recurring_invoice.delete", userId, orgId, resourceType: "recurring_invoice_template", resourceId: String(id) });
    return { success: true };
  }

  async runNow(orgId: string, userId: string, id: number) {
    const tpl = await this.get(orgId, id);
    return this.runTemplate(orgId, userId, tpl);
  }

  async runDueRecurringInvoices(orgId?: string) {
    const today = new Date().toISOString().slice(0, 10);
    const conditions = [
      eq(finRecurringInvoiceTemplates.isActive, true),
      or(lte(finRecurringInvoiceTemplates.nextRunDate, today), isNull(finRecurringInvoiceTemplates.nextRunDate)),
    ];
    if (orgId) conditions.push(eq(finRecurringInvoiceTemplates.orgId, orgId));

    const templates = await this.db
      .select()
      .from(finRecurringInvoiceTemplates)
      .where(and(...conditions));

    const results: { templateId: number; invoiceId?: number; error?: string }[] = [];
    for (const tpl of templates) {
      try {
        const result = await this.runTemplate(tpl.orgId, tpl.createdBy, tpl);
        results.push({ templateId: tpl.id, invoiceId: result.invoiceId });
      } catch (error) {
        results.push({ templateId: tpl.id, error: error instanceof Error ? error.message : String(error) });
        logger.error("Recurring invoice template run failed", { templateId: tpl.id, orgId: tpl.orgId });
      }
    }
    return { ran: results.length, results };
  }

  private async runTemplate(orgId: string, userId: string, tpl: typeof finRecurringInvoiceTemplates.$inferSelect) {
    const parseResult = createInvoiceSchema.safeParse(tpl.payload);
    if (!parseResult.success) {
      logger.error("Recurring invoice template has invalid payload", { templateId: tpl.id, orgId: tpl.orgId, error: parseResult.error.message });
      throw new Error(`Template ${tpl.id} payload validation failed: ${parseResult.error.message}`);
    }
    const payload = parseResult.data;
    const { invoice } = await this.invoicesWrite.createInvoice(orgId, userId, payload);

    const nextRunDate = advanceByFrequency(tpl.nextRunDate ?? new Date().toISOString().slice(0, 10), tpl.frequency);
    await this.db
      .update(finRecurringInvoiceTemplates)
      .set({ lastRunDate: new Date().toISOString().slice(0, 10), nextRunDate, updatedAt: new Date() })
      .where(eq(finRecurringInvoiceTemplates.id, tpl.id));

    void this.dispatch.emit({
      eventKey: "accounting.invoice.recurring_generated",
      orgId,
      targetUserIds: [userId],
      entityType: "invoice",
      entityId: String(invoice.id),
      title: "Recurring invoice generated",
      message: `Invoice ${invoice.invoiceNumber} generated from template ${tpl.name}`,
    }).catch(() => undefined);

    return { invoiceId: invoice.id };
  }
}
