import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, lte, sum } from "drizzle-orm";
import { indianStates, invoices, invoiceItems, purchaseBills } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type {
  Gstr1PlaceBucket,
  Gstr1RateBucket,
  Gstr1Report,
  Gstr1Section,
  Gstr1Section1,
  Gstr3BTaxBlock,
} from "./accounting.types";
import { type Gstr1Query, type Gstr3BQuery } from "./dto/accounting.schemas";

const GSTR1_STATUSES = ["ISSUED", "PAID", "FAILED"] as const;
const OUTWARD_STATUSES = ["ISSUED", "PAID", "FAILED"] as const;
const INWARD_STATUSES = ["POSTED", "PARTIALLY_PAID", "PAID"] as const;

interface InvoiceRow {
  id: number;
  status: string;
  placeOfSupply: string | null;
  customerGstin: string | null;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
}

interface ItemRow {
  invoiceId: number;
  gstRate: string;
  amount: string;
}

interface BucketAccumulator {
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  invoiceIds: Set<number>;
}

interface PlaceAccumulator {
  placeOfSupply: string | null;
  rates: Map<string, BucketAccumulator>;
}

interface SectionAccumulator {
  section: Gstr1Section;
  places: Map<string, PlaceAccumulator>;
  invoiceIds: Set<number>;
}

function normalizeRate(rate: string): string {
  const n = Number(rate);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

function placeKey(code: string | null): string {
  return code ?? "__UNKNOWN__";
}

function classifyInvoice(row: InvoiceRow): Gstr1Section {
  const gstin = row.customerGstin?.trim() ?? "";
  return gstin.length > 0 ? "B2B" : "B2C";
}

function emptySection(section: Gstr1Section): Gstr1Section1 {
  return {
    section,
    places: [],
    totalTaxableValue: "0.00",
    totalCgst: "0.00",
    totalSgst: "0.00",
    totalIgst: "0.00",
    totalInvoices: 0,
  };
}

function emptyBlock(): Gstr3BTaxBlock {
  return { taxableValue: "0.00", cgst: "0.00", sgst: "0.00", igst: "0.00" };
}

function buildBlock(taxable: number, cgst: number, sgst: number, igst: number): Gstr3BTaxBlock {
  return { taxableValue: taxable.toFixed(2), cgst: cgst.toFixed(2), sgst: sgst.toFixed(2), igst: igst.toFixed(2) };
}

@Injectable()
export class AccountingGstService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private getOrCreateSection(map: Map<Gstr1Section, SectionAccumulator>, section: Gstr1Section): SectionAccumulator {
    const existing = map.get(section);
    if (existing) return existing;
    const fresh: SectionAccumulator = { section, places: new Map(), invoiceIds: new Set() };
    map.set(section, fresh);
    return fresh;
  }

  private getOrCreatePlace(section: SectionAccumulator, placeOfSupply: string | null): PlaceAccumulator {
    const key = placeKey(placeOfSupply);
    const existing = section.places.get(key);
    if (existing) return existing;
    const fresh: PlaceAccumulator = { placeOfSupply, rates: new Map() };
    section.places.set(key, fresh);
    return fresh;
  }

  private getOrCreateBucket(place: PlaceAccumulator, rate: string): BucketAccumulator {
    const existing = place.rates.get(rate);
    if (existing) return existing;
    const fresh: BucketAccumulator = { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, invoiceIds: new Set() };
    place.rates.set(rate, fresh);
    return fresh;
  }

  private allocateInvoice(
    invoice: InvoiceRow,
    lines: ReadonlyArray<ItemRow>,
    sections: Map<Gstr1Section, SectionAccumulator>,
  ): void {
    const section = this.getOrCreateSection(sections, classifyInvoice(invoice));
    section.invoiceIds.add(invoice.id);
    const place = this.getOrCreatePlace(section, invoice.placeOfSupply);

    const invoiceCgst = Number(invoice.cgstAmount);
    const invoiceSgst = Number(invoice.sgstAmount);
    const invoiceIgst = Number(invoice.igstAmount);

    const taxableTotal = lines.reduce((acc, l) => acc + Number(l.amount), 0);
    const weightedTaxTotal = lines.reduce((acc, l) => {
      const taxable = Number(l.amount);
      const rate = Number(l.gstRate);
      return acc + (taxable * rate) / 100;
    }, 0);

    for (const line of lines) {
      const lineTaxable = Number(line.amount);
      const lineRate = Number(line.gstRate);
      const bucket = this.getOrCreateBucket(place, normalizeRate(line.gstRate));

      let cgstShare = 0;
      let sgstShare = 0;
      let igstShare = 0;
      if (weightedTaxTotal > 0 && lineRate > 0) {
        const ratio = (lineTaxable * lineRate) / 100 / weightedTaxTotal;
        cgstShare = invoiceCgst * ratio;
        sgstShare = invoiceSgst * ratio;
        igstShare = invoiceIgst * ratio;
      } else if (lineRate === 0 && taxableTotal === 0) {
        cgstShare = 0;
        sgstShare = 0;
        igstShare = 0;
      }

      bucket.taxableValue += lineTaxable;
      bucket.cgst += cgstShare;
      bucket.sgst += sgstShare;
      bucket.igst += igstShare;
      bucket.invoiceIds.add(invoice.id);
    }
  }

  private buildRateBuckets(rates: Map<string, BucketAccumulator>): Gstr1RateBucket[] {
    const result: Gstr1RateBucket[] = [];
    for (const [rate, bucket] of rates) {
      result.push({
        gstRate: rate,
        taxableValue: bucket.taxableValue.toFixed(2),
        cgst: bucket.cgst.toFixed(2),
        sgst: bucket.sgst.toFixed(2),
        igst: bucket.igst.toFixed(2),
        invoiceCount: bucket.invoiceIds.size,
      });
    }
    result.sort((a, b) => Number(a.gstRate) - Number(b.gstRate));
    return result;
  }

  private buildPlaceBuckets(section: SectionAccumulator, stateNameByCode: Map<string, string>): Gstr1PlaceBucket[] {
    const places: Gstr1PlaceBucket[] = [];
    for (const place of section.places.values()) {
      const placeName = place.placeOfSupply ? stateNameByCode.get(place.placeOfSupply) ?? null : null;
      places.push({ placeOfSupply: place.placeOfSupply, placeName, rates: this.buildRateBuckets(place.rates) });
    }
    places.sort((a, b) => (a.placeOfSupply ?? "").localeCompare(b.placeOfSupply ?? ""));
    return places;
  }

  private summarizeSection(section: SectionAccumulator, stateNameByCode: Map<string, string>): Gstr1Section1 {
    const places = this.buildPlaceBuckets(section, stateNameByCode);
    let totalTaxableValue = 0;
    let totalCgst = 0;
    let totalSgst = 0;
    let totalIgst = 0;
    for (const place of section.places.values()) {
      for (const bucket of place.rates.values()) {
        totalTaxableValue += bucket.taxableValue;
        totalCgst += bucket.cgst;
        totalSgst += bucket.sgst;
        totalIgst += bucket.igst;
      }
    }
    return {
      section: section.section,
      places,
      totalTaxableValue: totalTaxableValue.toFixed(2),
      totalCgst: totalCgst.toFixed(2),
      totalSgst: totalSgst.toFixed(2),
      totalIgst: totalIgst.toFixed(2),
      totalInvoices: section.invoiceIds.size,
    };
  }

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
    const grand = { taxable: 0, cgst: 0, sgst: 0, igst: 0, invoiceIds: new Set<number>() };

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
        this.allocateInvoice(invoice, lines, sections);
        grand.invoiceIds.add(invoice.id);
        grand.cgst += Number(invoice.cgstAmount);
        grand.sgst += Number(invoice.sgstAmount);
        grand.igst += Number(invoice.igstAmount);
        for (const line of lines) grand.taxable += Number(line.amount);
      }
    }

    const stateNameByCode = await this.loadStateNameMap();
    const b2bAccum = sections.get("B2B");
    const b2cAccum = sections.get("B2C");

    return {
      from,
      to,
      b2b: b2bAccum ? this.summarizeSection(b2bAccum, stateNameByCode) : emptySection("B2B"),
      b2c: b2cAccum ? this.summarizeSection(b2cAccum, stateNameByCode) : emptySection("B2C"),
      grandTotal: {
        taxableValue: grand.taxable.toFixed(2),
        cgst: grand.cgst.toFixed(2),
        sgst: grand.sgst.toFixed(2),
        igst: grand.igst.toFixed(2),
        invoices: grand.invoiceIds.size,
      },
    };
  }

  async gstr3b(orgId: string, query: Gstr3BQuery) {
    const { from, to } = query;
    const fromDate = new Date(`${from}T00:00:00.000Z`);
    const toDate = new Date(`${to}T23:59:59.999Z`);

    const outwardAgg = await this.db
      .select({
        taxable: sum(invoices.subtotal),
        cgst: sum(invoices.cgstAmount),
        sgst: sum(invoices.sgstAmount),
        igst: sum(invoices.igstAmount),
        discount: sum(invoices.discount),
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.orgId, orgId),
          inArray(invoices.status, [...OUTWARD_STATUSES]),
          gte(invoices.createdAt, fromDate),
          lte(invoices.createdAt, toDate),
        ),
      );
    const outwardRow = outwardAgg[0] ?? { taxable: "0", cgst: "0", sgst: "0", igst: "0", discount: "0" };
    const outwardTaxable = Number(outwardRow.taxable ?? 0) - Number(outwardRow.discount ?? 0);
    const outwardCgst = Number(outwardRow.cgst ?? 0);
    const outwardSgst = Number(outwardRow.sgst ?? 0);
    const outwardIgst = Number(outwardRow.igst ?? 0);

    const outwardCount = await this.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.orgId, orgId),
          inArray(invoices.status, [...OUTWARD_STATUSES]),
          gte(invoices.createdAt, fromDate),
          lte(invoices.createdAt, toDate),
        ),
      );

    const reverseChargeAgg = await this.db
      .select({
        taxable: sum(invoices.subtotal),
        cgst: sum(invoices.cgstAmount),
        sgst: sum(invoices.sgstAmount),
        igst: sum(invoices.igstAmount),
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.orgId, orgId),
          inArray(invoices.status, [...OUTWARD_STATUSES]),
          eq(invoices.reverseCharge, true),
          gte(invoices.createdAt, fromDate),
          lte(invoices.createdAt, toDate),
        ),
      );
    const rcRow = reverseChargeAgg[0] ?? { taxable: "0", cgst: "0", sgst: "0", igst: "0" };
    const rcTaxable = Number(rcRow.taxable ?? 0);
    const rcCgst = Number(rcRow.cgst ?? 0);
    const rcSgst = Number(rcRow.sgst ?? 0);
    const rcIgst = Number(rcRow.igst ?? 0);

    const inwardAgg = await this.db
      .select({
        taxable: sum(purchaseBills.subtotal),
        cgst: sum(purchaseBills.cgstAmount),
        sgst: sum(purchaseBills.sgstAmount),
        igst: sum(purchaseBills.igstAmount),
        discount: sum(purchaseBills.discount),
      })
      .from(purchaseBills)
      .where(
        and(
          eq(purchaseBills.orgId, orgId),
          inArray(purchaseBills.status, [...INWARD_STATUSES]),
          gte(purchaseBills.billDate, from),
          lte(purchaseBills.billDate, to),
        ),
      );
    const inwardRow = inwardAgg[0] ?? { taxable: "0", cgst: "0", sgst: "0", igst: "0", discount: "0" };
    const itcTaxable = Number(inwardRow.taxable ?? 0) - Number(inwardRow.discount ?? 0);
    const itcCgst = Number(inwardRow.cgst ?? 0);
    const itcSgst = Number(inwardRow.sgst ?? 0);
    const itcIgst = Number(inwardRow.igst ?? 0);

    const inwardCount = await this.db
      .select({ id: purchaseBills.id })
      .from(purchaseBills)
      .where(
        and(
          eq(purchaseBills.orgId, orgId),
          inArray(purchaseBills.status, [...INWARD_STATUSES]),
          gte(purchaseBills.billDate, from),
          lte(purchaseBills.billDate, to),
        ),
      );

    const netCgst = Math.max(0, outwardCgst - itcCgst);
    const netSgst = Math.max(0, outwardSgst - itcSgst);
    const netIgst = Math.max(0, outwardIgst - itcIgst);
    const netTotal = netCgst + netSgst + netIgst;

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
        cgst: netCgst.toFixed(2),
        sgst: netSgst.toFixed(2),
        igst: netIgst.toFixed(2),
        total: netTotal.toFixed(2),
      },
      invoiceCount: outwardCount.length,
      billCount: inwardCount.length,
    };
  }
}
