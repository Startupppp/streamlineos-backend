import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  creditNotes,
  creditNoteItems,
  invoices,
  accNumberSequences,
  finApprovalPolicies,
  finApprovalRequests,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { JournalPostingService, type DraftLine } from "../../accounting/posting/journal-posting.service";
import { AuditService } from "../../../common/audit/audit.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { buildListResponse, paginateOffset } from "../../../common/pagination/pagination";
import type { CreateCreditNoteInput, ListCreditNotesQuery, ApplyCreditNoteInput } from "./dto/finance-ar.schemas";
import { logSideEffectFailure } from "../../../common/logger/side-effect";

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

@Injectable()
export class CreditNotesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: JournalPostingService,
    private readonly audit: AuditService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async list(orgId: string, query: ListCreditNotesQuery) {
    const { limit, offset } = paginateOffset(query);
    const conditions = [eq(creditNotes.orgId, orgId)];
    if (query.status) conditions.push(eq(creditNotes.status, query.status));
    if (query.clientId) conditions.push(eq(creditNotes.clientId, query.clientId));

    const [rows, [{ count }]] = await Promise.all([
      this.db.select().from(creditNotes).where(and(...conditions)).orderBy(desc(creditNotes.createdAt)).limit(limit).offset(offset),
      this.db.select({ count: sql<number>`count(*)::int` }).from(creditNotes).where(and(...conditions)),
    ]);
    return buildListResponse(rows, count, query);
  }

  async get(orgId: string, id: number) {
    const cn = await this.db.query.creditNotes.findFirst({
      where: and(eq(creditNotes.id, id), eq(creditNotes.orgId, orgId)),
      with: { items: true },
    });
    if (!cn) throw new NotFoundException("Credit note not found");
    return cn;
  }

  async create(orgId: string, userId: string, input: CreateCreditNoteInput) {
    const itemsWithAmounts = input.items.map((it, idx) => {
      const amount = round4(it.quantity * it.rate);
      const tax = round4(amount * (it.gstRate / 100));
      return { ...it, amount, tax, lineOrder: idx };
    });

    const subtotal = round4(itemsWithAmounts.reduce((acc, it) => acc + it.amount, 0));
    const taxPool = round4(itemsWithAmounts.reduce((acc, it) => acc + it.tax, 0));
    const cgstAmount = round4(taxPool / 2);
    const sgstAmount = round4(taxPool / 2);
    const igstAmount = 0;
    const total = round4(subtotal + taxPool);

    const cn = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(creditNotes)
        .values({
          orgId,
          creditNoteNumber: `CN-DRAFT-${Date.now()}`,
          clientId: input.clientId ?? null,
          invoiceId: input.invoiceId ?? null,
          status: "DRAFT",
          reason: input.reason ?? null,
          subtotal: subtotal.toFixed(4),
          taxAmount: taxPool.toFixed(4),
          cgstAmount: cgstAmount.toFixed(4),
          sgstAmount: sgstAmount.toFixed(4),
          igstAmount: igstAmount.toFixed(4),
          total: total.toFixed(4),
          currency: input.currency,
          placeOfSupply: input.placeOfSupply ?? null,
          customerGstin: input.customerGstin ?? null,
          supplierGstin: input.supplierGstin ?? null,
          notes: input.notes ?? null,
          createdBy: userId,
        })
        .returning();

      if (!inserted) throw new Error("Credit note insert returned no rows");

      await tx.insert(creditNoteItems).values(
        itemsWithAmounts.map((it) => ({
          orgId,
          creditNoteId: inserted.id,
          description: it.description,
          hsnSacCode: it.hsnSacCode ?? null,
          quantity: it.quantity.toFixed(4),
          rate: it.rate.toFixed(4),
          gstRate: it.gstRate.toFixed(2),
          amount: it.amount.toFixed(4),
          lineOrder: it.lineOrder,
        })),
      );

      return inserted;
    });

    this.audit.log({ action: "credit_note.create", userId, orgId, resourceType: "credit_note", resourceId: String(cn.id) });
    return cn;
  }

  async post(orgId: string, userId: string, id: number) {
    const cn = await this.db.query.creditNotes.findFirst({
      where: and(eq(creditNotes.id, id), eq(creditNotes.orgId, orgId)),
    });
    if (!cn) throw new NotFoundException("Credit note not found");
    if (cn.status !== "DRAFT") throw new ForbiddenException("Only DRAFT credit notes can be posted");

    const total = Number(cn.total);

    const policy = await this.db
      .select({ id: finApprovalPolicies.id, approverUserId: finApprovalPolicies.approverUserId, minAmount: finApprovalPolicies.minAmount })
      .from(finApprovalPolicies)
      .where(and(eq(finApprovalPolicies.orgId, orgId), eq(finApprovalPolicies.recordType, "CREDIT_NOTE"), eq(finApprovalPolicies.isActive, true)))
      .limit(1);

    const activePolicy = policy[0];
    if (activePolicy && Number(activePolicy.minAmount ?? 0) <= total) {
      await this.db.insert(finApprovalRequests).values({
        orgId,
        recordType: "CREDIT_NOTE",
        recordId: id,
        status: "PENDING",
        requestedBy: userId,
        note: `Credit note ${cn.creditNoteNumber} requires approval`,
      });
      if (activePolicy.approverUserId) {
        await this.dispatch.emit({
          eventKey: "accounting.approval.requested",
          orgId,
          actorUserId: userId,
          targetUserIds: [activePolicy.approverUserId],
          entityType: "credit_note",
          entityId: String(id),
          title: "Credit note approval required",
          message: `Credit note ${cn.creditNoteNumber} requires approval (total: ${total.toFixed(2)})`,
        }).catch(logSideEffectFailure("credit note approval notification dispatch", { orgId, creditNoteId: id }));
      }
      return { needsApproval: true, creditNoteId: id };
    }

    return this.db.transaction(async (tx) => {
      const [seq] = await tx
        .insert(accNumberSequences)
        .values({ orgId, entityType: "credit_note", prefix: "CN", nextNumber: 2, padding: 4 })
        .onConflictDoUpdate({
          target: [accNumberSequences.orgId, accNumberSequences.entityType],
          set: { nextNumber: sql`${accNumberSequences.nextNumber} + 1` },
        })
        .returning();

      if (!seq) throw new Error("Sequence upsert returned no rows");
      const creditNoteNumber = `${seq.prefix}-${String(seq.nextNumber - 1).padStart(seq.padding, "0")}`;

      await tx.update(creditNotes).set({ creditNoteNumber, status: "POSTED", updatedAt: new Date() }).where(eq(creditNotes.id, id));

      await this.posting.seedChartOfAccountsForOrg(orgId);

      const subtotal = Number(cn.subtotal);
      const cgst = Number(cn.cgstAmount);
      const sgst = Number(cn.sgstAmount);
      const igst = Number(cn.igstAmount);

      const lines: DraftLine[] = [
        { accountCode: "4000", debit: subtotal, credit: 0, description: `Credit note ${creditNoteNumber}` },
        { accountCode: "1200", debit: 0, credit: total, description: `Credit note ${creditNoteNumber}` },
      ];
      if (cgst > 0) lines.push({ accountCode: "2110", debit: cgst, credit: 0, description: `Credit note ${creditNoteNumber} CGST` });
      if (sgst > 0) lines.push({ accountCode: "2111", debit: sgst, credit: 0, description: `Credit note ${creditNoteNumber} SGST` });
      if (igst > 0) lines.push({ accountCode: "2112", debit: igst, credit: 0, description: `Credit note ${creditNoteNumber} IGST` });

      const today = new Date().toISOString().slice(0, 10);
      await this.posting.persistJournalEntry({
        orgId,
        entryDate: today,
        description: `Credit note ${creditNoteNumber} posted`,
        sourceType: "credit_note",
        sourceId: String(id),
        sourceEvent: "post",
        createdBy: userId,
        lines,
      }, tx);

      this.audit.log({ action: "credit_note.post", userId, orgId, resourceType: "credit_note", resourceId: String(id) });
      return { success: true, creditNoteNumber };
    });
  }

  async apply(orgId: string, userId: string, id: number, input: ApplyCreditNoteInput) {
    await this.db.transaction(async (tx) => {
      const [cn] = await tx
        .select({ id: creditNotes.id, status: creditNotes.status, appliedAmount: creditNotes.appliedAmount, total: creditNotes.total })
        .from(creditNotes)
        .where(and(eq(creditNotes.id, id), eq(creditNotes.orgId, orgId)))
        .for("update");
      if (!cn) throw new NotFoundException("Credit note not found");
      if (cn.status !== "POSTED") throw new ForbiddenException("Only POSTED credit notes can be applied");

      const [inv] = await tx
        .select({ id: invoices.id, total: invoices.total, amountPaid: invoices.amountPaid, status: invoices.status })
        .from(invoices)
        .where(and(eq(invoices.id, input.invoiceId), eq(invoices.orgId, orgId)))
        .for("update");
      if (!inv) throw new NotFoundException("Invoice not found");

      const newApplied = round4(Number(cn.appliedAmount) + input.amount);
      const cnTotal = Number(cn.total);
      const newInvPaid = round4(Number(inv.amountPaid) + input.amount);
      const invTotal = Number(inv.total);
      const newInvStatus = newInvPaid >= invTotal - 0.01 ? "PAID" : "PARTIALLY_PAID";

      await tx
        .update(invoices)
        .set({ amountPaid: newInvPaid.toFixed(4), status: newInvStatus, updatedAt: new Date() })
        .where(and(eq(invoices.id, input.invoiceId), eq(invoices.orgId, orgId)));

      const newCnStatus = newApplied >= cnTotal - 0.01 ? "APPLIED" : "POSTED";
      await tx
        .update(creditNotes)
        .set({ appliedAmount: newApplied.toFixed(4), status: newCnStatus, updatedAt: new Date() })
        .where(and(eq(creditNotes.id, id), eq(creditNotes.orgId, orgId)));
    });

    this.audit.log({ action: "credit_note.apply", userId, orgId, resourceType: "credit_note", resourceId: String(id), metadata: { invoiceId: input.invoiceId, amount: input.amount } });
    return { success: true };
  }
}
