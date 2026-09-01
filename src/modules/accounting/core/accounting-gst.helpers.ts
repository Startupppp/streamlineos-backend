import type {
  Gstr1PlaceBucket,
  Gstr1RateBucket,
  Gstr1Section,
  Gstr1Section1,
  Gstr3BTaxBlock,
} from "./accounting.types";

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
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
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

export function buildBlock(taxable: number, cgst: number, sgst: number, igst: number): Gstr3BTaxBlock {
  return { taxableValue: taxable.toFixed(2), cgst: cgst.toFixed(2), sgst: sgst.toFixed(2), igst: igst.toFixed(2) };
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
  const fresh: BucketAccumulator = { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, invoiceIds: new Set() };
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
    const bucket = getOrCreateBucket(place, normalizeRate(line.gstRate));

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

export function buildRateBuckets(rates: Map<string, BucketAccumulator>): Gstr1RateBucket[] {
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
