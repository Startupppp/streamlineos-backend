import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import { and, count, eq, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  finRecurringBillTemplates,
  purchaseBills,
  purchaseBillItems,
  clients,
} from "../../db/schema";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { buildListResponse, paginateOffset } from "../../common/pagination/pagination";
import type {
  CreateRecurringBillInput,
  UpdateRecurringBillInput,
  ListRecurringBillsQuery,
} from "./dto/finance-ap.schemas";
import { addFrequencyDays } from "./recurring-bills.util";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const RECURRING_CACHE_KEY = (orgId: string) => `fin:recurring-bills:${orgId}`;

@Injectable()
export class RecurringBillsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async listTemplates(orgId: string, query: ListRecurringBillsQuery) {
    const { page, pageSize, isActive } = query;
    const conds = [eq(finRecurringBillTemplates.orgId, orgId)];
    if (isActive !== undefined) conds.push(eq(finRecurringBillTemplates.isActive, isActive));

    const where = and(...conds);
    const { offset, limit } = paginateOffset({ page, pageSize });

    const [items, totalRows] = await Promise.all([
      this.db
        .select({
          id: finRecurringBillTemplates.id,
          orgId: finRecurringBillTemplates.orgId,
          name: finRecurringBillTemplates.name,
          vendorId: finRecurringBillTemplates.vendorId,
          vendorName: clients.name,
          frequency: finRecurringBillTemplates.frequency,
          nextRunDate: finRecurringBillTemplates.nextRunDate,
          lastRunDate: finRecurringBillTemplates.lastRunDate,
          endDate: finRecurringBillTemplates.endDate,
          isActive: finRecurringBillTemplates.isActive,
          payload: finRecurringBillTemplates.payload,
          createdBy: finRecurringBillTemplates.createdBy,
          createdAt: finRecurringBillTemplates.createdAt,
          updatedAt: finRecurringBillTemplates.updatedAt,
        })
        .from(finRecurringBillTemplates)
        .leftJoin(clients, eq(clients.id, finRecurringBillTemplates.vendorId))
        .where(where)
        .offset(offset)
        .limit(limit),
      this.db.select({ c: count() }).from(finRecurringBillTemplates).where(where),
    ]);

    return buildListResponse(items, Number(totalRows[0]?.c ?? 0), { page, pageSize });
  }

  async getTemplate(orgId: string, templateId: number) {
    const rows = await this.db
      .select()
      .from(finRecurringBillTemplates)
      .where(and(eq(finRecurringBillTemplates.id, templateId), eq(finRecurringBillTemplates.orgId, orgId)))
      .limit(1);

    const template = rows[0];
    if (!template) throw new NotFoundException("Recurring bill template not found");
    return template;
  }

  async createTemplate(orgId: string, userId: string, input: CreateRecurringBillInput) {
    const [inserted] = await this.db
      .insert(finRecurringBillTemplates)
      .values({
        orgId,
        name: input.name,
        vendorId: input.vendorId ?? null,
        frequency: input.frequency,
        nextRunDate: input.nextRunDate ?? null,
        endDate: input.endDate ?? null,
        isActive: input.isActive,
        payload: input.payload,
        createdBy: userId,
      })
      .returning();

    if (!inserted) throw new Error("Recurring bill template insert returned no rows");
    void this.cache.invalidate(RECURRING_CACHE_KEY(orgId));

    this.audit.log({
      action: "accounting.recurring_bill.create",
      userId,
      orgId,
      resourceType: "recurring_bill_template",
      resourceId: String(inserted.id),
      result: "SUCCESS",
    });

    return inserted;
  }

  async updateTemplate(orgId: string, userId: string, templateId: number, input: UpdateRecurringBillInput) {
    const existing = await this.getTemplate(orgId, templateId);

    const [updated] = await this.db
      .update(finRecurringBillTemplates)
      .set({
        name: input.name ?? existing.name,
        vendorId: input.vendorId !== undefined ? input.vendorId : existing.vendorId,
        frequency: input.frequency ?? existing.frequency,
        nextRunDate: input.nextRunDate !== undefined ? input.nextRunDate : existing.nextRunDate,
        endDate: input.endDate !== undefined ? input.endDate : existing.endDate,
        isActive: input.isActive !== undefined ? input.isActive : existing.isActive,
        payload: input.payload !== undefined ? input.payload : existing.payload,
        updatedAt: new Date(),
      })
      .where(and(eq(finRecurringBillTemplates.id, templateId), eq(finRecurringBillTemplates.orgId, orgId)))
      .returning();

    void this.cache.invalidate(RECURRING_CACHE_KEY(orgId));

    this.audit.log({
      action: "accounting.recurring_bill.update",
      userId,
      orgId,
      resourceType: "recurring_bill_template",
      resourceId: String(templateId),
      result: "SUCCESS",
    });

    return updated;
  }

  async deleteTemplate(orgId: string, userId: string, templateId: number) {
    await this.getTemplate(orgId, templateId);

    await this.db
      .delete(finRecurringBillTemplates)
      .where(and(eq(finRecurringBillTemplates.id, templateId), eq(finRecurringBillTemplates.orgId, orgId)));

    void this.cache.invalidate(RECURRING_CACHE_KEY(orgId));

    this.audit.log({
      action: "accounting.recurring_bill.delete",
      userId,
      orgId,
      resourceType: "recurring_bill_template",
      resourceId: String(templateId),
      result: "SUCCESS",
    });

    return { id: templateId, deleted: true };
  }

  async runNow(orgId: string, userId: string, templateId: number) {
    const template = await this.getTemplate(orgId, templateId);
    if (!template.isActive) {
      throw new ConflictException("Template is inactive");
    }

    const bill = await this.spawnBillFromTemplate(orgId, userId, template);

    const nextRun = addFrequencyDays(new Date(), template.frequency);
    await this.db
      .update(finRecurringBillTemplates)
      .set({ lastRunDate: new Date().toISOString().slice(0, 10), nextRunDate: nextRun, updatedAt: new Date() })
      .where(and(eq(finRecurringBillTemplates.id, templateId), eq(finRecurringBillTemplates.orgId, orgId)));

    return { templateId, billId: bill.id, billNumber: bill.billNumber };
  }

  async runDueRecurringBills(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);

    const due = await this.db
      .select()
      .from(finRecurringBillTemplates)
      .where(
        and(
          eq(finRecurringBillTemplates.isActive, true),
          lte(finRecurringBillTemplates.nextRunDate, today),
        ),
      );

    for (const template of due) {
      if (template.endDate && template.endDate < today) {
        await this.db
          .update(finRecurringBillTemplates)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(finRecurringBillTemplates.id, template.id));
        continue;
      }

      try {
        const bill = await this.spawnBillFromTemplate(template.orgId, template.createdBy, template);
        const nextRun = addFrequencyDays(new Date(), template.frequency);

        await this.db
          .update(finRecurringBillTemplates)
          .set({ lastRunDate: today, nextRunDate: nextRun, updatedAt: new Date() })
          .where(eq(finRecurringBillTemplates.id, template.id));

        void this.dispatch.emit({
          eventKey: "accounting.bill.recurring_generated",
          orgId: template.orgId,
          actorUserId: null,
          targetUserIds: [template.createdBy],
          entityType: "purchase_bill",
          entityId: String(bill.id),
          variables: { billNumber: bill.billNumber, templateName: template.name },
        });
      } catch {
      }
    }
  }

  private async spawnBillFromTemplate(
    orgId: string,
    userId: string,
    template: typeof finRecurringBillTemplates.$inferSelect,
  ) {
    const recurringBillPayloadSchema = z.object({
      vendorId: z.number(),
      billDate: z.string(),
      dueDate: z.string().optional(),
      placeOfSupply: z.string().optional(),
      vendorGstin: z.string().optional(),
      supplierGstin: z.string().optional(),
      reverseCharge: z.boolean(),
      discount: z.number(),
      notes: z.string().optional(),
      expenseAccountCode: z.string(),
      items: z.array(z.object({
        description: z.string(),
        hsnSacCode: z.string().optional(),
        quantity: z.number(),
        rate: z.number(),
        gstRate: z.number(),
      })),
    });

    const parseResult = recurringBillPayloadSchema.safeParse(template.payload);
    if (!parseResult.success) {
      throw new Error(`Invalid recurring bill template payload for template ${template.id}: ${parseResult.error.message}`);
    }
    const payload = parseResult.data;

    const today = new Date().toISOString().slice(0, 10);

    const itemsWithAmounts = payload.items.map((it, idx) => {
      const amount = round2(it.quantity * it.rate);
      const tax = round2(amount * (it.gstRate / 100));
      return { ...it, amount, tax, lineOrder: idx };
    });

    const subtotal = round2(itemsWithAmounts.reduce((acc, it) => acc + it.amount, 0));
    const taxPool = round2(itemsWithAmounts.reduce((acc, it) => acc + it.tax, 0));
    const discount = round2(payload.discount ?? 0);
    const total = round2(subtotal + taxPool - discount);

    const supplierStateCode =
      payload.supplierGstin && payload.supplierGstin.length >= 2
        ? payload.supplierGstin.slice(0, 2)
        : payload.placeOfSupply ?? "";
    const placeOfSupplyStateCode = payload.placeOfSupply ?? supplierStateCode;
    const intra = supplierStateCode === placeOfSupplyStateCode && supplierStateCode !== "";
    const cgst = intra ? round2(taxPool / 2) : 0;
    const sgst = intra ? round2(taxPool - cgst) : 0;
    const igst = intra ? 0 : taxPool;

    return this.db.transaction(async (tx) => {
      const countRows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(purchaseBills)
        .where(eq(purchaseBills.orgId, orgId));
      const existingCount = countRows[0]?.count ?? 0;
      const billNumber = `BILL-${new Date().getFullYear()}-${String(existingCount + 1).padStart(4, "0")}`;

      const [inserted] = await tx
        .insert(purchaseBills)
        .values({
          orgId,
          vendorId: payload.vendorId,
          billNumber,
          vendorBillNumber: null,
          billDate: today,
          dueDate: payload.dueDate ?? null,
          status: "DRAFT",
          subtotal: subtotal.toFixed(4),
          taxAmount: taxPool.toFixed(4),
          cgstAmount: cgst.toFixed(4),
          sgstAmount: sgst.toFixed(4),
          igstAmount: igst.toFixed(4),
          discount: discount.toFixed(4),
          total: total.toFixed(4),
          currency: "INR",
          placeOfSupply: placeOfSupplyStateCode || null,
          vendorGstin: payload.vendorGstin && payload.vendorGstin.length > 0 ? payload.vendorGstin : null,
          supplierGstin: payload.supplierGstin && payload.supplierGstin.length > 0 ? payload.supplierGstin : null,
          reverseCharge: payload.reverseCharge,
          notes: payload.notes ?? null,
          expenseAccountCode: payload.expenseAccountCode,
          recurringTemplateId: template.id,
          createdBy: userId,
        })
        .returning();

      if (!inserted) throw new Error("Recurring bill insert returned no rows");

      if (itemsWithAmounts.length > 0) {
        await tx.insert(purchaseBillItems).values(
          itemsWithAmounts.map((it) => ({
            billId: inserted.id,
            description: it.description,
            hsnSacCode: it.hsnSacCode ?? null,
            quantity: it.quantity.toFixed(4),
            rate: it.rate.toFixed(4),
            gstRate: it.gstRate.toFixed(2),
            amount: it.amount.toFixed(4),
            lineOrder: it.lineOrder,
          })),
        );
      }

      return inserted;
    });
  }
}
