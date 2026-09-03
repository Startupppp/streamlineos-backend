import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  finRecurringBillTemplates,
  purchaseBills,
  purchaseBillItems,
  clients,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { decodeCursor, buildCursorPage } from "../../../common/pagination/cursor";
import { keysetAfterValue } from "../../../common/pagination/keyset";
import type {
  CreateRecurringBillInput,
  UpdateRecurringBillInput,
  ListRecurringBillsQuery,
} from "./dto/finance-ap.schemas";
import { addFrequencyDays } from "./recurring-bills.util";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const RECURRING_CACHE_KEY = (orgId: string) => `fin:recurring-bills:${orgId}`;

/** Templates fetched by one sweep. The deactivation statement below carries at most this many ids. */
const DUE_TEMPLATE_SCAN_LIMIT = 1000;

/**
 * Ids per deactivation `UPDATE … WHERE id = ANY($1)`. The sweep can only see
 * {@link DUE_TEMPLATE_SCAN_LIMIT} templates, so this bounds the bind payload and the number of
 * rows one statement locks at a time; a failed chunk deactivates only its own ids.
 */
const EXPIRE_TEMPLATE_CHUNK = 500;

@Injectable()
export class RecurringBillsService {
  private readonly logger = new Logger(RecurringBillsService.name);
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async listTemplates(orgId: string, query: ListRecurringBillsQuery) {
    const { cursor, limit, isActive } = query;
    const pos = decodeCursor(cursor);
    const pageLimit = Math.min(limit, 100);

    const conds = [eq(finRecurringBillTemplates.orgId, orgId)];
    if (isActive !== undefined) conds.push(eq(finRecurringBillTemplates.isActive, isActive));
    if (pos) conds.push(keysetAfterValue(finRecurringBillTemplates.name, finRecurringBillTemplates.id, pos));

    const rows = await this.db
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
      .where(and(...conds))
      .orderBy(asc(finRecurringBillTemplates.name), asc(finRecurringBillTemplates.id))
      .limit(pageLimit + 1);

    return buildCursorPage(rows, pageLimit, (row) => ({
      sortValue: row.name,
      id: String(row.id),
    }));
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
    await this.cache.invalidate(RECURRING_CACHE_KEY(orgId));

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

    await this.cache.invalidate(RECURRING_CACHE_KEY(orgId));

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

    await this.cache.invalidate(RECURRING_CACHE_KEY(orgId));

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

    const nextRun = addFrequencyDays(new Date(), template.frequency);

    const bill = await this.db.transaction(async (tx) => {
      const spawned = await this.spawnBillFromTemplate(orgId, userId, template, tx);
      await tx
        .update(finRecurringBillTemplates)
        .set({ lastRunDate: new Date().toISOString().slice(0, 10), nextRunDate: nextRun, updatedAt: new Date() })
        .where(and(eq(finRecurringBillTemplates.id, templateId), eq(finRecurringBillTemplates.orgId, orgId)));
      return spawned;
    });

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
      )
      .limit(DUE_TEMPLATE_SCAN_LIMIT);

    const expiredIds: number[] = [];
    const expiredOrgIds = new Set<string>();
    const runnable: typeof due = [];
    for (const template of due) {
      if (template.endDate && template.endDate < today) {
        expiredIds.push(template.id);
        expiredOrgIds.add(template.orgId);
      } else {
        runnable.push(template);
      }
    }

    await this.deactivateExpired(expiredIds, [...expiredOrgIds]);

    for (const template of runnable) {
      try {
        const bill = await this.claimAndSpawn(template, today);
        if (!bill) continue;

        await this.dispatch.emit({
          eventKey: "accounting.bill.recurring_generated",
          orgId: template.orgId,
          actorUserId: null,
          targetUserIds: [template.createdBy],
          entityType: "purchase_bill",
          entityId: String(bill.id),
          variables: { billNumber: bill.billNumber, templateName: template.name },
        });
      } catch (err) {
        this.logger.warn(`Recurring bill spawn failed for template ${template.id} (org ${template.orgId}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * One `UPDATE` per {@link EXPIRE_TEMPLATE_CHUNK}, not one per organisation.
   * `fin_recurring_bill_templates.id` is a serial primary key, so the id list alone identifies the
   * rows exactly; the organisation list rides along so the statement stays tenant-correlated.
   */
  private async deactivateExpired(ids: readonly number[], orgIds: readonly string[]): Promise<void> {
    if (ids.length === 0 || orgIds.length === 0) return;
    for (let offset = 0; offset < ids.length; offset += EXPIRE_TEMPLATE_CHUNK) {
      const chunk = ids.slice(offset, offset + EXPIRE_TEMPLATE_CHUNK);
      await this.db
        .update(finRecurringBillTemplates)
        .set({ isActive: false, updatedAt: new Date() })
        .where(
          and(
            inArray(finRecurringBillTemplates.id, chunk),
            inArray(finRecurringBillTemplates.orgId, [...orgIds]),
          ),
        );
    }
  }

  /**
   * The bill and the template advance commit together, and the advance goes FIRST as a
   * compare-and-set on the due predicate.
   *
   * They were two separate round trips, so a crash between them left the bill committed with
   * `next_run_date` unmoved — and `purchase_bills` carries no idempotency key over
   * (template, date), so the next sweep spawned a SECOND bill against the same vendor with
   * nothing to stop it. Claiming first also makes two concurrent sweeps safe: the loser blocks
   * on the row lock, re-reads `next_run_date <= today` against the winner's committed row,
   * matches nothing and spawns nothing.
   */
  private async claimAndSpawn(
    template: typeof finRecurringBillTemplates.$inferSelect,
    today: string,
  ): Promise<{ id: number; billNumber: string } | null> {
    const nextRun = addFrequencyDays(new Date(), template.frequency);
    return this.db.transaction(async (tx) => {
      const claimed = await tx
        .update(finRecurringBillTemplates)
        .set({ lastRunDate: today, nextRunDate: nextRun, updatedAt: new Date() })
        .where(
          and(
            eq(finRecurringBillTemplates.id, template.id),
            eq(finRecurringBillTemplates.orgId, template.orgId),
            eq(finRecurringBillTemplates.isActive, true),
            lte(finRecurringBillTemplates.nextRunDate, today),
          ),
        )
        .returning({ id: finRecurringBillTemplates.id });

      if (!claimed[0]) return null;
      return this.spawnBillFromTemplate(template.orgId, template.createdBy, template, tx);
    });
  }

  private async spawnBillFromTemplate(
    orgId: string,
    userId: string,
    template: typeof finRecurringBillTemplates.$inferSelect,
    tx: Tx,
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
  }
}
