import type {
  Gstr1PlaceBucket,
  Gstr1RateBucket,
  Gstr1Section,
  Gstr1Section1,
  Gstr3BTaxBlock,
} from "./accounting.types";
import {
  addDecimals,
  allocateDecimal,
  multiplyDecimals,
  roundDecimal,
  sumDecimals,
  toDecimal,
} from "./money.util";

export interface InvoiceRow {
  id: number;
  status: string;
  placeOfSupply: string | null;
  customerGstin: string | null;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
}

export interface ItemRow {
  invoiceId: number;
  gstRate: string;
  amount: string;
}

export interface BucketAccumulator {
  taxableValue: string;
  cgst: string;
  sgst: string;
  igst: string;
  invoiceIds: Set<number>;
}

export interface PlaceAccumulator {
  placeOfSupply: string | null;
  rates: Map<string, BucketAccumulator>;
}

export interface SectionAccumulator {
  section: Gstr1Section;
  places: Map<string, PlaceAccumulator>;
  invoiceIds: Set<number>;
}

export function normalizeRate(rate: string): string {
  const n = Number(rate);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

export function placeKey(code: string | null): string {
  return code ?? "__UNKNOWN__";
}

export function classifyInvoice(row: InvoiceRow): Gstr1Section {
  const gstin = row.customerGstin?.trim() ?? "";
  return gstin.length > 0 ? "B2B" : "B2C";
}

export function emptySection(section: Gstr1Section): Gstr1Section1 {
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

export function emptyBlock(): Gstr3BTaxBlock {
  return { taxableValue: "0.00", cgst: "0.00", sgst: "0.00", igst: "0.00" };
}

export function buildBlock(taxable: string, cgst: string, sgst: string, igst: string): Gstr3BTaxBlock {
  return {
    taxableValue: roundDecimal(taxable, 2),
    cgst: roundDecimal(cgst, 2),
    sgst: roundDecimal(sgst, 2),
    igst: roundDecimal(igst, 2),
  };
}

export function getOrCreateSection(
  map: Map<Gstr1Section, SectionAccumulator>,
  section: Gstr1Section,
): SectionAccumulator {
  const existing = map.get(section);
  if (existing) return existing;
  const fresh: SectionAccumulator = { section, places: new Map(), invoiceIds: new Set() };
  map.set(section, fresh);
  return fresh;
}

export function getOrCreatePlace(
  section: SectionAccumulator,
  placeOfSupply: string | null,
): PlaceAccumulator {
  const key = placeKey(placeOfSupply);
  const existing = section.places.get(key);
  if (existing) return existing;
  const fresh: PlaceAccumulator = { placeOfSupply, rates: new Map() };
  section.places.set(key, fresh);
  return fresh;
}

export function getOrCreateBucket(place: PlaceAccumulator, rate: string): BucketAccumulator {
  const existing = place.rates.get(rate);
  if (existing) return existing;
  const fresh: BucketAccumulator = {
    taxableValue: "0",
    cgst: "0",
    sgst: "0",
    igst: "0",
    invoiceIds: new Set(),
  };
  place.rates.set(rate, fresh);
  return fresh;
}

export function allocateInvoice(
  invoice: InvoiceRow,
  lines: ReadonlyArray<ItemRow>,
  sections: Map<Gstr1Section, SectionAccumulator>,
): void {
  const section = getOrCreateSection(sections, classifyInvoice(invoice));
  section.invoiceIds.add(invoice.id);
  const place = getOrCreatePlace(section, invoice.placeOfSupply);

  const weights = lines.map((line) =>
    multiplyDecimals(toDecimal(line.amount), toDecimal(line.gstRate)),
  );
  const cgstShares = allocateDecimal(toDecimal(invoice.cgstAmount), weights);
  const sgstShares = allocateDecimal(toDecimal(invoice.sgstAmount), weights);
  const igstShares = allocateDecimal(toDecimal(invoice.igstAmount), weights);

  lines.forEach((line, index) => {
    const bucket = getOrCreateBucket(place, normalizeRate(line.gstRate));
    bucket.taxableValue = addDecimals(bucket.taxableValue, toDecimal(line.amount));
    bucket.cgst = addDecimals(bucket.cgst, cgstShares[index]);
    bucket.sgst = addDecimals(bucket.sgst, sgstShares[index]);
    bucket.igst = addDecimals(bucket.igst, igstShares[index]);
    bucket.invoiceIds.add(invoice.id);
  });
}

export function buildRateBuckets(rates: Map<string, BucketAccumulator>): Gstr1RateBucket[] {
  const result: Gstr1RateBucket[] = [];
  for (const [rate, bucket] of rates) {
    result.push({
      gstRate: rate,
      taxableValue: roundDecimal(bucket.taxableValue, 2),
      cgst: roundDecimal(bucket.cgst, 2),
      sgst: roundDecimal(bucket.sgst, 2),
      igst: roundDecimal(bucket.igst, 2),
      invoiceCount: bucket.invoiceIds.size,
    });
  }
  result.sort((a, b) => Number(a.gstRate) - Number(b.gstRate));
  return result;
}

export function buildPlaceBuckets(
  section: SectionAccumulator,
  stateNameByCode: Map<string, string>,
): Gstr1PlaceBucket[] {
  const places: Gstr1PlaceBucket[] = [];
  for (const place of section.places.values()) {
    const placeName = place.placeOfSupply ? stateNameByCode.get(place.placeOfSupply) ?? null : null;
    places.push({ placeOfSupply: place.placeOfSupply, placeName, rates: buildRateBuckets(place.rates) });
  }
  places.sort((a, b) => (a.placeOfSupply ?? "").localeCompare(b.placeOfSupply ?? ""));
  return places;
}

export function summarizeSection(
  section: SectionAccumulator,
  stateNameByCode: Map<string, string>,
): Gstr1Section1 {
  const places = buildPlaceBuckets(section, stateNameByCode);
  const buckets = Array.from(section.places.values()).flatMap((place) =>
    Array.from(place.rates.values()),
  );
  return {
    section: section.section,
    places,
    totalTaxableValue: roundDecimal(sumDecimals(buckets.map((b) => b.taxableValue)), 2),
    totalCgst: roundDecimal(sumDecimals(buckets.map((b) => b.cgst)), 2),
    totalSgst: roundDecimal(sumDecimals(buckets.map((b) => b.sgst)), 2),
    totalIgst: roundDecimal(sumDecimals(buckets.map((b) => b.igst)), 2),
    totalInvoices: section.invoiceIds.size,
  };
}
