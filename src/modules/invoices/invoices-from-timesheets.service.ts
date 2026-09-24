import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import {
  TimesheetInvoicingService,
  type InvoiceableTimesheetEntry,
} from "../timesheets/core/timesheet-invoicing.service";
import { InvoicesPostingService } from "./invoices-posting.service";
import { assertDealBelongsToOrg, resolveProjectDealId } from "./lib/deal-link";
import { gstSplit, resolveSupplierStateCode, round2 } from "./lib/invoice-helpers";
import {
  insertInvoiceWithItems,
  type InvoiceLineToInsert,
  type InvoiceRow,
} from "./lib/invoice-insert";
import { invoiceLineDescription } from "./lib/invoice-line-description";
import type { InvoiceLineDetail } from "../timesheets/core/invoice-line-detail";
import type { CreateInvoiceFromTimesheetsInput } from "./dto/invoice-write.schemas";

export const TIMESHEET_INVOICE_DEFAULT_CURRENCY = "INR";

type PricedInvoiceLine = Omit<InvoiceLineToInsert, "description">;

function priceFor(
  entry: InvoiceableTimesheetEntry,
  gstRate: number,
  lineOrder: number,
): PricedInvoiceLine {
  const quantity = parseFloat(entry.hours);
  const rate = parseFloat(entry.billRate ?? "0");
  return {
    quantity,
    rate,
    gstRate,
    amount: round2(quantity * rate),
    lineOrder,
    timesheetEntryId: entry.id,
  };
}

function lineFor(
  entry: InvoiceableTimesheetEntry,
  gstRate: number,
  lineOrder: number,
  detail: InvoiceLineDetail,
): InvoiceLineToInsert {
  return {
    ...priceFor(entry, gstRate, lineOrder),
    description: invoiceLineDescription(entry, detail),
  };
}

@Injectable()
export class InvoicesFromTimesheetsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: InvoicesPostingService,
    private readonly audit: AuditService,
    private readonly planLimits: PlanLimitsService,
    private readonly cache: CacheService,
    private readonly timesheetInvoicing: TimesheetInvoicingService,
  ) {}

  async createFromTimesheets(
    orgId: string,
    userId: string,
    input: CreateInvoiceFromTimesheetsInput,
  ): Promise<{
    invoice: InvoiceRow;
    timesheetEntryIds: number[];
    posted: boolean;
  }> {
    await this.planLimits.assertWithinLimit(orgId, "acctInvoices");

    const entries = await this.timesheetInvoicing.loadInvoiceableEntries(
      orgId,
      input.timesheetEntryIds,
    );
    const entryIds = entries.map((entry) => entry.id);

    const currencies = [
      ...new Set(
        entries.map(
          (entry) => entry.currency ?? TIMESHEET_INVOICE_DEFAULT_CURRENCY,
        ),
      ),
    ];
    if (currencies.length > 1)
      throw new BadRequestException(
        `Selected time is billed in more than one currency (${currencies.join(", ")}); invoice each currency separately`,
      );
    const currency =
      input.currency ?? currencies[0] ?? TIMESHEET_INVOICE_DEFAULT_CURRENCY;

    const projectIds = [
      ...new Set(
        entries
          .map((entry) => entry.projectId)
          .filter((id): id is number => id !== null),
      ),
    ];
    if (input.projectId !== undefined && !projectIds.includes(input.projectId))
      throw new BadRequestException(
        "None of the selected time belongs to the requested project",
      );
    const projectId =
      input.projectId ?? (projectIds.length === 1 ? projectIds[0] : undefined);

    const priced = entries.map((entry, index) =>
      priceFor(entry, input.gstRate, index),
    );

    const subtotal = round2(priced.reduce((acc, it) => acc + it.amount, 0));
    const taxPool = round2(
      priced.reduce(
        (acc, it) => acc + round2(it.amount * (it.gstRate / 100)),
        0,
      ),
    );
    const discount = round2(input.discount);
    if (discount > round2(subtotal + taxPool))
      throw new BadRequestException(
        "Discount cannot exceed the invoice subtotal plus tax",
      );
    const total = round2(subtotal + taxPool - discount);

    const supplierStateCode = await resolveSupplierStateCode(this.db, orgId);
    const placeOfSupplyStateCode = input.placeOfSupply ?? supplierStateCode;
    const split = gstSplit(taxPool, supplierStateCode, placeOfSupplyStateCode);

    const status = input.status;

    const invoice = await this.db.transaction(async (tx) => {
      const lineDetail = await this.timesheetInvoicing.resolveInvoiceLineDetail(
        tx,
        orgId,
        entries.map((entry) => entry.projectId),
      );
      const lines = entries.map((entry, index) =>
        lineFor(entry, input.gstRate, index, lineDetail),
      );

      const dealId = input.dealId
        ? await assertDealBelongsToOrg(tx, orgId, input.dealId)
        : await resolveProjectDealId(
            tx,
            orgId,
            entries.map((entry) => entry.projectId),
          );

      const inserted = await insertInvoiceWithItems(
        tx,
        orgId,
        userId,
        {
          clientId: input.clientId,
          projectId,
          dealId,
          status,
          subtotal,
          taxPool,
          discount,
          total,
          currency,
          dueDate: input.dueDate,
          notes: input.notes,
          placeOfSupply: placeOfSupplyStateCode,
          customerGstin: input.customerGstin,
          supplierGstin: input.supplierGstin,
          reverseCharge: input.reverseCharge,
          taxInclusive: input.taxInclusive,
          split,
        },
        lines,
      );

      const claimed = await this.timesheetInvoicing.markEntriesInvoiced(
        tx,
        orgId,
        entryIds,
      );
      if (claimed !== entryIds.length)
        throw new ConflictException(
          "Some of the selected time was invoiced by another request; nothing was billed",
        );

      if (status === "ISSUED") {
        const invoiceDate = (inserted.createdAt ?? new Date())
          .toISOString()
          .slice(0, 10);
        await this.posting.postInvoiceIssued(
          orgId,
          userId,
          {
            invoiceId: inserted.id,
            invoiceNumber: inserted.invoiceNumber,
            invoiceDate,
            currency: inserted.currency,
            subtotal,
            discount,
            cgst: split.cgst,
            sgst: split.sgst,
            igst: split.igst,
            total,
          },
          tx,
        );
      }

      return inserted;
    });

    const invalidate = () =>
      this.cache.invalidateNamespaceForOrg(orgId, "invoices:list");
    if (!registerAfterCommit(invalidate)) await invalidate();

    this.audit.log({
      action: "accounting.invoice.created_from_timesheets",
      userId,
      orgId,
      resourceType: "invoice",
      resourceId: String(invoice.id),
      result: "SUCCESS",
      metadata: { timesheetEntryIds: entryIds, projectId: projectId ?? null },
    });

    return { invoice, timesheetEntryIds: entryIds, posted: status === "ISSUED" };
  }
}
