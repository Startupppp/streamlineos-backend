import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { invoices, payments, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { InvoicesPostingService } from "./invoices-posting.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { CrmAutomationBusService } from "../crm/automation-studio/crm-automation-bus.service";

type DbOrTx = Parameters<Parameters<Db["transaction"]>[0]>[0] | Db;

@Injectable()
export class InvoicesLifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: InvoicesPostingService,
    private readonly dispatch: NotificationDispatchService,
    private readonly bus: CrmAutomationBusService,
  ) {}

  async recomputeInvoiceBalance(invoiceId: number, tx: DbOrTx): Promise<void> {
    const [{ totalPaid }] = await tx
      .select({ totalPaid: sql<number>`COALESCE(sum(${payments.amount}::numeric), 0)::float` })
      .from(payments)
      .where(eq(payments.invoiceId, invoiceId));

    const invoice = await tx.query.invoices.findFirst({
      where: eq(invoices.id, invoiceId),
      columns: { total: true, status: true, dueDate: true, orgId: true },
    });

    if (!invoice) return;

    const invTotal = Number(invoice.total);
    const today = new Date().toISOString().slice(0, 10);
    let newStatus = invoice.status;

    if (totalPaid >= invTotal - 0.005) {
      newStatus = "PAID";
    } else if (totalPaid > 0) {
      newStatus = "PARTIALLY_PAID";
    } else if (invoice.dueDate && invoice.dueDate < today && invoice.status === "ISSUED") {
      newStatus = "OVERDUE";
    }

    await tx
      .update(invoices)
      .set({
        amountPaid: totalPaid.toFixed(4),
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

  /**
   * Voiding an issued invoice reverses its journal rather than deleting it.
   *
   * The retired `fin_payment_allocations` guard is gone with the table: an
   * allocation only ever existed alongside a payment row, so the payment check
   * below already covers every case it did.
   */
  async voidInvoice(orgId: string, userId: string, invoiceId: number): Promise<{ success: true }> {
    const invoice = await this.db.query.invoices.findFirst({
      where: and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId)),
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    if (invoice.status === "VOIDED") {
      throw new BadRequestException("Invoice is already voided");
    }

    const [{ paymentCount }] = await this.db
      .select({ paymentCount: sql<number>`count(*)::int` })
      .from(payments)
      .where(and(eq(payments.orgId, orgId), eq(payments.invoiceId, invoiceId)));
    if (paymentCount > 0) {
      throw new BadRequestException("Cannot void an invoice that has payments recorded");
    }

    // No-op when the invoice was never posted (a draft, or an organisation
    // without accounting enabled) — the kernel finds the original by source.
    await this.posting.reverseInvoiceIssued(
      orgId,
      userId,
      invoiceId,
      new Date().toISOString().slice(0, 10),
    );

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
      .where(inArray(invoices.id, ids));

    for (const inv of dueInvoices) {
      const targetUserIds: string[] = [];
      if (inv.collectionOwnerId) {
        targetUserIds.push(inv.collectionOwnerId);
      } else {
        const members = await this.db
          .select({ userId: organizationMembers.userId })
          .from(organizationMembers)
          .where(eq(organizationMembers.orgId, inv.orgId))
          .limit(5);
        targetUserIds.push(...members.map((m) => m.userId));
      }
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
}
