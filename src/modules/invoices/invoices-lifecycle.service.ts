import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { invoices, payments, finPaymentAllocations, organizationMembers, journalEntries } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { FinancePostingService } from "../accounting/posting/finance-posting.service";
import { INVOICE_SEND_SOURCE_EVENT, INVOICE_SOURCE_TYPE } from "../accounting/posting/journal-posting.data";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { CrmAutomationBusService } from "../crm/automation-studio/crm-automation-bus.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { systemActor } from "../../common/auth/system-actor";
import { compareDecimals, subtractDecimals, toDecimal } from "../accounting/core/money.util";

type DbOrTx = Parameters<Parameters<Db["transaction"]>[0]>[0] | Db;

/**
 * `payments.amount` is `numeric(12,2)` while `invoices.total` is `numeric(18,4)`,
 * so an invoice whose total carries sub-paisa components can never be settled to
 * the last 0.0050 by any sequence of receipts. That half-paisa is the entire
 * tolerance — it is a scale reconciliation, not slack for arithmetic error.
 */
const PAID_TOLERANCE = "0.0050";

/**
 * Fallback notification recipients per organisation for an overdue invoice that
 * names no collection owner.
 *
 * The read is loop-INVARIANT per organisation — the same membership query, with
 * the same answer, once per invoice — so it is resolved for every organisation
 * in the sweep in one ranked pass before the notification loop starts. The rank
 * filter is what keeps that one statement equivalent to the per-org `LIMIT`:
 * without it a single organisation's membership would fill the whole result.
 */
const FALLBACK_RECIPIENTS_PER_ORG = 5;

@Injectable()
export class InvoicesLifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly financePosting: FinancePostingService,
    private readonly dispatch: NotificationDispatchService,
    private readonly bus: CrmAutomationBusService,
  ) {}

  async recomputeInvoiceBalance(invoiceId: number, tx: DbOrTx): Promise<void> {
    const [{ totalPaid }] = await tx
      .select({ totalPaid: sql<string>`COALESCE(sum(${payments.amount}), 0)::text` })
      .from(payments)
      .where(eq(payments.invoiceId, invoiceId));

    const invoice = await tx.query.invoices.findFirst({
      where: eq(invoices.id, invoiceId),
      columns: { total: true, status: true, dueDate: true, orgId: true },
    });

    if (!invoice) return;

    const paid = toDecimal(totalPaid);
    const outstanding = subtractDecimals(toDecimal(invoice.total), paid);
    const today = new Date().toISOString().slice(0, 10);
    let newStatus = invoice.status;

    if (compareDecimals(outstanding, PAID_TOLERANCE) <= 0) {
      newStatus = "PAID";
    } else if (compareDecimals(paid, "0") > 0) {
      newStatus = "PARTIALLY_PAID";
    } else if (invoice.dueDate && invoice.dueDate < today && invoice.status === "ISSUED") {
      newStatus = "OVERDUE";
    }

    await tx
      .update(invoices)
      .set({
        amountPaid: paid,
        status: newStatus,
        ...(newStatus === "PAID" ? { paidAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, invoiceId));

    if (newStatus === "PAID") {
      void this.bus.emit(invoice.orgId, "invoice.paid", {
        entityType: "invoice",
        entityId: String(invoiceId),
        data: { invoiceId, paidAt: new Date().toISOString() },
      }).catch(() => undefined);
    }
  }

  async voidInvoice(orgId: string, userId: string, invoiceId: number): Promise<{ success: true }> {
    const invoice = await this.db.query.invoices.findFirst({
      where: and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId)),
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    if (invoice.status === "VOIDED") {
      throw new BadRequestException("Invoice is already voided");
    }

    const [{ allocationCount }] = await this.db
      .select({ allocationCount: sql<number>`count(*)::int` })
      .from(finPaymentAllocations)
      .where(and(eq(finPaymentAllocations.orgId, orgId), eq(finPaymentAllocations.invoiceId, invoiceId)));
    if (allocationCount > 0) {
      throw new BadRequestException("Cannot void an invoice with payment allocations");
    }

    const [{ paymentCount }] = await this.db
      .select({ paymentCount: sql<number>`count(*)::int` })
      .from(payments)
      .where(and(eq(payments.orgId, orgId), eq(payments.invoiceId, invoiceId)));
    if (paymentCount > 0) {
      throw new BadRequestException("Cannot void an invoice that has payments recorded");
    }

    const existingEntry = await this.db.query.journalEntries.findFirst({
      where: and(
        eq(journalEntries.orgId, orgId),
        eq(journalEntries.sourceType, INVOICE_SOURCE_TYPE),
        eq(journalEntries.sourceId, String(invoiceId)),
        eq(journalEntries.sourceEvent, INVOICE_SEND_SOURCE_EVENT),
      ),
      columns: { id: true, status: true },
    });

    if (existingEntry && existingEntry.status === "POSTED") {
      const ctx = systemActor("invoices.void-reversal", orgId, userId);
      await this.financePosting.reverseJournal(ctx, existingEntry.id, `Void invoice ${invoice.invoiceNumber}`);
    }

    await this.db
      .update(invoices)
      .set({ status: "VOIDED", updatedAt: new Date() })
      .where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId)));

    return { success: true };
  }

  async markOverdueInvoices(orgId?: string): Promise<{ updated: number }> {
    const today = new Date().toISOString().slice(0, 10);
    const conditions = [
      inArray(invoices.status, ["ISSUED", "SENT"]),
      lte(invoices.dueDate, today),
    ];
    if (orgId) conditions.push(eq(invoices.orgId, orgId));

    const dueInvoices = await this.db
      .select({
        id: invoices.id,
        orgId: invoices.orgId,
        invoiceNumber: invoices.invoiceNumber,
        collectionOwnerId: invoices.collectionOwnerId,
      })
      .from(invoices)
      .where(and(...conditions));

    if (dueInvoices.length === 0) return { updated: 0 };

    const ids = dueInvoices.map((i) => i.id);
    await this.db
      .update(invoices)
      .set({ status: "OVERDUE", updatedAt: new Date() })
      .where(
        orgId
          ? and(inArray(invoices.id, ids), eq(invoices.orgId, orgId))
          : inArray(invoices.id, ids),
      );

    const fallbackRecipients = await this.loadFallbackRecipients(
      dueInvoices.filter((inv) => !inv.collectionOwnerId).map((inv) => inv.orgId),
    );

    for (const inv of dueInvoices) {
      const targetUserIds = inv.collectionOwnerId
        ? [inv.collectionOwnerId]
        : fallbackRecipients.get(inv.orgId) ?? [];
      if (targetUserIds.length > 0) {
        await this.dispatch.emit({
          eventKey: "accounting.invoice.overdue",
          orgId: inv.orgId,
          targetUserIds,
          entityType: "invoice",
          entityId: String(inv.id),
          title: "Invoice overdue",
          message: `Invoice ${inv.invoiceNumber} is now overdue`,
        }).catch(() => undefined);
      }
    }

    return { updated: dueInvoices.length };
  }

  private async loadFallbackRecipients(orgIds: readonly string[]): Promise<Map<string, string[]>> {
    const byOrg = new Map<string, string[]>();
    const distinct = [...new Set(orgIds)];
    if (distinct.length === 0) return byOrg;

    const ranked = this.db
      .select({
        orgId: organizationMembers.orgId,
        userId: organizationMembers.userId,
        memberRank: sql<number>`row_number() over (partition by ${organizationMembers.orgId} order by ${organizationMembers.userId})`.as("member_rank"),
      })
      .from(organizationMembers)
      .where(inArray(organizationMembers.orgId, distinct))
      .as("ranked_org_members");

    const rows = await this.db
      .select({ orgId: ranked.orgId, userId: ranked.userId })
      .from(ranked)
      .where(lte(ranked.memberRank, FALLBACK_RECIPIENTS_PER_ORG));

    for (const row of rows) {
      const members = byOrg.get(row.orgId);
      if (members) members.push(row.userId);
      else byOrg.set(row.orgId, [row.userId]);
    }
    return byOrg;
  }
}
