import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db, TenantTx } from "../../../db/drizzle.types";
import {
  billingCreditNoteLines,
  billingCreditNotes,
  billingInvoiceLineSnapshots,
  billingInvoiceSnapshots,
} from "../../../db/schema";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { type RoundingRule } from "./money-rounding";
import { allocateDocumentNumber } from "./invoice-numbering";
import { assertOneOf } from "./lib/enum-guard";
import {
  priceDocument,
  TAX_BEHAVIORS,
  type InvoiceLineInput,
  type TaxBehavior,
} from "./invoice-pricing";

export const INVOICE_STATUSES = ["DRAFT", "ISSUED", "PAID", "VOID"] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export { type TaxBehavior } from "./invoice-pricing";

export { type InvoiceLineInput } from "./invoice-pricing";

export interface IssueInvoiceInput {
  orgId: string;
  subscriptionId?: number | null;
  currency: string;
  taxBehavior: TaxBehavior;
  lines: InvoiceLineInput[];
  sellerName?: string | null;
  sellerAddress?: Record<string, unknown> | null;
  sellerTaxIds?: Record<string, string> | null;
  buyerName?: string | null;
  buyerAddress?: Record<string, unknown> | null;
  buyerTaxIds?: Record<string, string> | null;
  placeOfSupply?: string | null;
  fxRateMicro?: number | null;
  fxRateSource?: string | null;
  fxRateCapturedAt?: Date | null;
  roundingRule?: RoundingRule;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  dueAt?: Date | null;
  numberPrefix?: string;
  issuedAt?: Date;
  createdBy?: string | null;
}

export interface IssuedInvoice {
  id: number;
  invoiceNumber: string;
  status: InvoiceStatus;
  currency: string;
  subtotalMinor: number;
  taxAmountMinor: number;
  totalMinor: number;
  issuedAt: Date;
  lineCount: number;
}

export interface CreditNoteInput {
  orgId: string;
  originalSnapshotId: number;
  noteType: "CREDIT" | "DEBIT";
  reason: string;
  createdBy: string;
  lines: InvoiceLineInput[];
  roundingRule?: RoundingRule;
  numberPrefix?: string;
  issuedAt?: Date;
}

@Injectable()
export class InvoiceSnapshotService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async issueInvoice(input: IssueInvoiceInput): Promise<IssuedInvoice> {
    if (input.lines.length === 0)
      throw new BadRequestException("An invoice needs at least one line");
    if (!/^[A-Z]{3}$/.test(input.currency))
      throw new BadRequestException("Currency must be a three-letter ISO code");

    const roundingRule: RoundingRule = input.roundingRule ?? "HALF_UP";
    const issuedAt = input.issuedAt ?? new Date();
    const { lines: priced, subtotalMinor, taxAmountMinor, totalMinor } = priceDocument(
      input.lines,
      roundingRule,
      input.taxBehavior,
    );

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const invoiceNumber = await allocateDocumentNumber(
          tx,
          input.orgId,
          input.numberPrefix ?? "INV",
          issuedAt.getUTCFullYear(),
        );

        const [snapshot] = await tx
          .insert(billingInvoiceSnapshots)
          .values({
            orgId: input.orgId,
            subscriptionId: input.subscriptionId ?? null,
            invoiceNumber,
            status: "ISSUED",
            sellerName: input.sellerName ?? null,
            sellerAddress: input.sellerAddress ?? null,
            sellerTaxIds: input.sellerTaxIds ?? null,
            buyerName: input.buyerName ?? null,
            buyerAddress: input.buyerAddress ?? null,
            buyerTaxIds: input.buyerTaxIds ?? null,
            placeOfSupply: input.placeOfSupply ?? null,
            taxBehavior: input.taxBehavior,
            currency: input.currency,
            fxRateMicro: input.fxRateMicro ?? null,
            fxRateSource: input.fxRateSource ?? null,
            fxRateCapturedAt: input.fxRateCapturedAt ?? null,
            subtotalMinor,
            taxAmountMinor,
            totalMinor,
            roundingRule,
            periodStart: input.periodStart ?? null,
            periodEnd: input.periodEnd ?? null,
            issuedAt,
            dueAt: input.dueAt ?? null,
            createdBy: input.createdBy ?? null,
          })
          .returning({ id: billingInvoiceSnapshots.id });

        if (!snapshot)
          throw new Error(
            `Invoice snapshot for org ${input.orgId} was not written`,
          );

        await tx.insert(billingInvoiceLineSnapshots).values(
          input.lines.map((line, index) => {
            const p = priced[index];
            if (!p) throw new Error(`Missing priced line at index ${index} for org ${input.orgId}`);
            return {
              snapshotId: snapshot.id,
              orgId: input.orgId,
              lineType: line.lineType,
              description: line.description,
              quantity: line.quantity,
              unitAmountMinor: line.unitAmountMinor,
              currency: input.currency,
              subtotalMinor: p.subtotalMinor,
              taxRateBps: line.taxRateBps ?? 0,
              taxAmountMinor: p.taxAmountMinor,
              totalMinor: p.totalMinor,
              prorationLineId: line.prorationLineId ?? null,
              usageRollupId: line.usageRollupId ?? null,
              sortOrder: index,
            };
          }),
        );

        return {
          id: snapshot.id,
          invoiceNumber,
          status: "ISSUED",
          currency: input.currency,
          subtotalMinor,
          taxAmountMinor,
          totalMinor,
          issuedAt,
          lineCount: input.lines.length,
        };
      },
      { orgId: input.orgId },
    );
  }

  /** Payment and voiding move status and stamp a time; no path here touches an amount, a rate or a currency. */
  async markPaid(
    orgId: string,
    snapshotId: number,
    paidAt = new Date(),
  ): Promise<void> {
    await this.transition(orgId, snapshotId, "PAID", {
      status: "PAID",
      paidAt,
    });
  }

  async voidInvoice(
    orgId: string,
    snapshotId: number,
    voidedAt = new Date(),
  ): Promise<void> {
    await this.transition(orgId, snapshotId, "VOID", {
      status: "VOID",
      voidedAt,
    });
  }

  private async transition(
    orgId: string,
    snapshotId: number,
    target: InvoiceStatus,
    set: Record<string, unknown>,
  ): Promise<void> {
    await runInTenantTransaction(
      this.db,
      async (tx) => {
        const snapshot = await this.load(tx, orgId, snapshotId);
        if (!snapshot)
          throw new NotFoundException("Invoice snapshot not found");
        if (snapshot.status === target) return;
        if (snapshot.status === "DRAFT")
          throw new ConflictException(
            `Cannot mark a draft invoice ${target}; issue it first`,
          );
        if (snapshot.status === "VOID")
          throw new ConflictException(
            "A voided invoice cannot change; issue a new one",
          );
        if (snapshot.status === "PAID" && target === "VOID")
          throw new ConflictException(
            "A paid invoice cannot be voided; issue a credit note instead",
          );

        await tx
          .update(billingInvoiceSnapshots)
          .set(set)
          .where(
            and(
              eq(billingInvoiceSnapshots.orgId, orgId),
              eq(billingInvoiceSnapshots.id, snapshotId),
            ),
          );
      },
      { orgId },
    );
  }

  async createCreditNote(
    input: CreditNoteInput,
  ): Promise<{ id: number; noteNumber: string; totalMinor: number }> {
    if (input.lines.length === 0)
      throw new BadRequestException("A credit note needs at least one line");

    const roundingRule: RoundingRule = input.roundingRule ?? "HALF_UP";
    const issuedAt = input.issuedAt ?? new Date();

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const original = await this.load(
          tx,
          input.orgId,
          input.originalSnapshotId,
        );
        if (!original)
          throw new NotFoundException("Invoice snapshot not found");
        if (original.status === "DRAFT")
          throw new ConflictException(
            "A draft invoice has nothing to credit; issue it first",
          );

        const { lines: priced, totalMinor } = priceDocument(
          input.lines,
          roundingRule,
          original.taxBehavior,
        );

        const noteNumber = await allocateDocumentNumber(
          tx,
          input.orgId,
          input.numberPrefix ?? "CN",
          issuedAt.getUTCFullYear(),
        );

        const [note] = await tx
          .insert(billingCreditNotes)
          .values({
            orgId: input.orgId,
            originalSnapshotId: input.originalSnapshotId,
            noteNumber,
            noteType: input.noteType,
            reason: input.reason,
            currency: original.currency,
            totalMinor,
            status: "ISSUED",
            issuedAt,
            createdBy: input.createdBy,
          })
          .returning({ id: billingCreditNotes.id });

        if (!note)
          throw new Error(`Credit note for org ${input.orgId} was not written`);

        await tx.insert(billingCreditNoteLines).values(
          input.lines.map((line, index) => {
            const p = priced[index];
            if (!p) throw new Error(`Missing priced line at index ${index} for org ${input.orgId}`);
            return {
              creditNoteId: note.id,
              orgId: input.orgId,
              description: line.description,
              quantity: line.quantity,
              unitAmountMinor: line.unitAmountMinor,
              currency: original.currency,
              subtotalMinor: p.subtotalMinor,
              taxRateBps: line.taxRateBps ?? 0,
              taxAmountMinor: p.taxAmountMinor,
              totalMinor: p.totalMinor,
              sortOrder: index,
            };
          }),
        );

        return { id: note.id, noteNumber, totalMinor };
      },
      { orgId: input.orgId },
    );
  }

  async getSnapshot(orgId: string, snapshotId: number) {
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const header = await this.load(tx, orgId, snapshotId);
        if (!header) throw new NotFoundException("Invoice snapshot not found");

        const lines = await tx
          .select({
            id: billingInvoiceLineSnapshots.id,
            lineType: billingInvoiceLineSnapshots.lineType,
            description: billingInvoiceLineSnapshots.description,
            quantity: billingInvoiceLineSnapshots.quantity,
            unitAmountMinor: billingInvoiceLineSnapshots.unitAmountMinor,
            currency: billingInvoiceLineSnapshots.currency,
            subtotalMinor: billingInvoiceLineSnapshots.subtotalMinor,
            taxRateBps: billingInvoiceLineSnapshots.taxRateBps,
            taxAmountMinor: billingInvoiceLineSnapshots.taxAmountMinor,
            totalMinor: billingInvoiceLineSnapshots.totalMinor,
          })
          .from(billingInvoiceLineSnapshots)
          .where(
            and(
              eq(billingInvoiceLineSnapshots.orgId, orgId),
              eq(billingInvoiceLineSnapshots.snapshotId, snapshotId),
            ),
          )
          .orderBy(asc(billingInvoiceLineSnapshots.sortOrder));

        return { ...header, lines };
      },
      { orgId },
    );
  }

  private async load(tx: TenantTx, orgId: string, snapshotId: number) {
    const [header] = await tx
      .select({
        id: billingInvoiceSnapshots.id,
        invoiceNumber: billingInvoiceSnapshots.invoiceNumber,
        status: billingInvoiceSnapshots.status,
        currency: billingInvoiceSnapshots.currency,
        taxBehavior: billingInvoiceSnapshots.taxBehavior,
        placeOfSupply: billingInvoiceSnapshots.placeOfSupply,
        fxRateMicro: billingInvoiceSnapshots.fxRateMicro,
        fxRateSource: billingInvoiceSnapshots.fxRateSource,
        fxRateCapturedAt: billingInvoiceSnapshots.fxRateCapturedAt,
        subtotalMinor: billingInvoiceSnapshots.subtotalMinor,
        taxAmountMinor: billingInvoiceSnapshots.taxAmountMinor,
        totalMinor: billingInvoiceSnapshots.totalMinor,
        roundingRule: billingInvoiceSnapshots.roundingRule,
        issuedAt: billingInvoiceSnapshots.issuedAt,
        paidAt: billingInvoiceSnapshots.paidAt,
        voidedAt: billingInvoiceSnapshots.voidedAt,
      })
      .from(billingInvoiceSnapshots)
      .where(
        and(
          eq(billingInvoiceSnapshots.orgId, orgId),
          eq(billingInvoiceSnapshots.id, snapshotId),
        ),
      )
      .limit(1);

    if (!header) return null;
    return {
      ...header,
      status: assertOneOf(INVOICE_STATUSES, header.status, "billing_invoice_snapshots.status"),
      taxBehavior: assertOneOf(TAX_BEHAVIORS, header.taxBehavior, "billing_invoice_snapshots.tax_behavior"),
    };
  }
}
