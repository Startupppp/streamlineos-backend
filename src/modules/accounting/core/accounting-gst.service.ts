import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, gte, inArray, lte, sum } from "drizzle-orm";
import { indianStates, invoices, invoiceItems, purchaseBills } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { Gstr1Report, Gstr1Section } from "./accounting.types";
import { type Gstr1Query, type Gstr3BQuery } from "./dto/accounting.schemas";
import {
  type InvoiceRow,
  type ItemRow,
  type SectionAccumulator,
  allocateInvoice,
  emptySection,
  emptyBlock,
  buildBlock,
  summarizeSection,
} from "./accounting-gst.helpers";
import {
  addDecimals,
  compareDecimals,
  roundDecimal,
  subtractDecimals,
  sumDecimals,
  toDecimal,
} from "./money.util";

const GSTR1_STATUSES = ["ISSUED", "PAID", "FAILED"] as const;
const OUTWARD_STATUSES = ["ISSUED", "PAID", "FAILED"] as const;
const INWARD_STATUSES = ["POSTED", "PARTIALLY_PAID", "PAID"] as const;

@Injectable()
export class AccountingGstService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async loadStateNameMap(): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ code: indianStates.stateCode, name: indianStates.stateName })
      .from(indianStates);
    const map = new Map<string, string>();
    for (const row of rows) map.set(row.code, row.name);
    return map;
  }

  async gstr1(orgId: string, query: Gstr1Query): Promise<Gstr1Report> {
    const { from, to } = query;
    const fromDate = new Date(`${from}T00:00:00.000Z`);
    const toDate = new Date(`${to}T23:59:59.999Z`);

    const invoiceRows: InvoiceRow[] = await this.db
      .select({
        id: invoices.id,
        status: invoices.status,
        placeOfSupply: invoices.placeOfSupply,
        customerGstin: invoices.customerGstin,
        cgstAmount: invoices.cgstAmount,
        sgstAmount: invoices.sgstAmount,
        igstAmount: invoices.igstAmount,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.orgId, orgId),
          inArray(invoices.status, [...GSTR1_STATUSES]),
          gte(invoices.createdAt, fromDate),
          lte(invoices.createdAt, toDate),
        ),
      );

    const sections = new Map<Gstr1Section, SectionAccumulator>();
    const grand = {
      taxable: "0",
      cgst: "0",
      sgst: "0",
      igst: "0",
      invoiceIds: new Set<number>(),
    };

    if (invoiceRows.length > 0) {
      const invoiceIds = invoiceRows.map((r) => r.id);
      const itemRows: ItemRow[] = await this.db
        .select({ invoiceId: invoiceItems.invoiceId, gstRate: invoiceItems.gstRate, amount: invoiceItems.amount })
        .from(invoiceItems)
        .where(inArray(invoiceItems.invoiceId, invoiceIds));

      const linesByInvoice = new Map<number, ItemRow[]>();
      for (const row of itemRows) {
        const list = linesByInvoice.get(row.invoiceId) ?? [];
        list.push(row);
        linesByInvoice.set(row.invoiceId, list);
      }

      for (const invoice of invoiceRows) {
        const lines = linesByInvoice.get(invoice.id) ?? [];
        if (lines.length === 0) continue;
        allocateInvoice(invoice, lines, sections);
        grand.invoiceIds.add(invoice.id);
        grand.cgst = addDecimals(grand.cgst, toDecimal(invoice.cgstAmount));
        grand.sgst = addDecimals(grand.sgst, toDecimal(invoice.sgstAmount));
        grand.igst = addDecimals(grand.igst, toDecimal(invoice.igstAmount));
        grand.taxable = addDecimals(grand.taxable, sumDecimals(lines.map((line) => line.amount)));
      }
    }

    const stateNameByCode = await this.loadStateNameMap();
    const b2bAccum = sections.get("B2B");
    const b2cAccum = sections.get("B2C");

    return {
      from,
      to,
      b2b: b2bAccum ? summarizeSection(b2bAccum, stateNameByCode) : emptySection("B2B"),
      b2c: b2cAccum ? summarizeSection(b2cAccum, stateNameByCode) : emptySection("B2C"),
      grandTotal: {
        taxableValue: roundDecimal(grand.taxable, 2),
        cgst: roundDecimal(grand.cgst, 2),
        sgst: roundDecimal(grand.sgst, 2),
        igst: roundDecimal(grand.igst, 2),
        invoices: grand.invoiceIds.size,
      },
    };
  }

  async gstr3b(orgId: string, query: Gstr3BQuery) {
    const { from, to } = query;
    const fromDate = new Date(`${from}T00:00:00.000Z`);
    const toDate = new Date(`${to}T23:59:59.999Z`);

    const outwardWhere = and(
      eq(invoices.orgId, orgId),
      inArray(invoices.status, [...OUTWARD_STATUSES]),
      gte(invoices.createdAt, fromDate),
      lte(invoices.createdAt, toDate),
    );
    const inwardWhere = and(
      eq(purchaseBills.orgId, orgId),
      inArray(purchaseBills.status, [...INWARD_STATUSES]),
      gte(purchaseBills.billDate, from),
      lte(purchaseBills.billDate, to),
    );

    const [outwardAgg, outwardCountRows, reverseChargeAgg, inwardAgg, inwardCountRows] = await Promise.all([
      this.db
        .select({
          taxable: sum(invoices.subtotal),
          cgst: sum(invoices.cgstAmount),
          sgst: sum(invoices.sgstAmount),
          igst: sum(invoices.igstAmount),
          discount: sum(invoices.discount),
        })
        .from(invoices)
        .where(outwardWhere),
      this.db.select({ c: count() }).from(invoices).where(outwardWhere),
      this.db
        .select({
          taxable: sum(invoices.subtotal),
          cgst: sum(invoices.cgstAmount),
          sgst: sum(invoices.sgstAmount),
          igst: sum(invoices.igstAmount),
        })
        .from(invoices)
        .where(and(outwardWhere, eq(invoices.reverseCharge, true))),
      this.db
        .select({
          taxable: sum(purchaseBills.subtotal),
          cgst: sum(purchaseBills.cgstAmount),
          sgst: sum(purchaseBills.sgstAmount),
          igst: sum(purchaseBills.igstAmount),
          discount: sum(purchaseBills.discount),
        })
        .from(purchaseBills)
        .where(inwardWhere),
      this.db.select({ c: count() }).from(purchaseBills).where(inwardWhere),
    ]);

    const outwardRow = outwardAgg[0] ?? { taxable: "0", cgst: "0", sgst: "0", igst: "0", discount: "0" };
    const outwardTaxable = subtractDecimals(
      toDecimal(outwardRow.taxable),
      toDecimal(outwardRow.discount),
    );
    const outwardCgst = toDecimal(outwardRow.cgst);
    const outwardSgst = toDecimal(outwardRow.sgst);
    const outwardIgst = toDecimal(outwardRow.igst);

    const rcRow = reverseChargeAgg[0] ?? { taxable: "0", cgst: "0", sgst: "0", igst: "0" };
    const rcTaxable = toDecimal(rcRow.taxable);
    const rcCgst = toDecimal(rcRow.cgst);
    const rcSgst = toDecimal(rcRow.sgst);
    const rcIgst = toDecimal(rcRow.igst);

    const inwardRow = inwardAgg[0] ?? { taxable: "0", cgst: "0", sgst: "0", igst: "0", discount: "0" };
    const itcTaxable = subtractDecimals(
      toDecimal(inwardRow.taxable),
      toDecimal(inwardRow.discount),
    );
    const itcCgst = toDecimal(inwardRow.cgst);
    const itcSgst = toDecimal(inwardRow.sgst);
    const itcIgst = toDecimal(inwardRow.igst);

    const netOfCredit = (output: string, credit: string): string => {
      const net = subtractDecimals(output, credit);
      return compareDecimals(net, "0") > 0 ? net : "0";
    };
    const netCgst = netOfCredit(outwardCgst, itcCgst);
    const netSgst = netOfCredit(outwardSgst, itcSgst);
    const netIgst = netOfCredit(outwardIgst, itcIgst);
    const netTotal = sumDecimals([netCgst, netSgst, netIgst]);

    return {
      from,
      to,
      outward: {
        taxable: buildBlock(outwardTaxable, outwardCgst, outwardSgst, outwardIgst),
        zeroRated: emptyBlock(),
        nilExempted: emptyBlock(),
        reverseCharge: buildBlock(rcTaxable, rcCgst, rcSgst, rcIgst),
      },
      itc: {
        available: buildBlock(itcTaxable, itcCgst, itcSgst, itcIgst),
        reversed: emptyBlock(),
        net: buildBlock(itcTaxable, itcCgst, itcSgst, itcIgst),
      },
      netTaxPayable: {
        cgst: roundDecimal(netCgst, 2),
        sgst: roundDecimal(netSgst, 2),
        igst: roundDecimal(netIgst, 2),
        total: roundDecimal(netTotal, 2),
      },
      invoiceCount: Number(outwardCountRows[0]?.c ?? 0),
      billCount: Number(inwardCountRows[0]?.c ?? 0),
    };
  }
}
