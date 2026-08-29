import { DocumentBuilder, type DocumentColumn } from "./document-builder";

export interface GrnNoteLine {
  readonly sku: string;
  readonly description: string;
  readonly uom: string;
  readonly quantityExpected: string | null;
  readonly quantityReceived: string;
  readonly lotNumber: string | null;
  readonly expiryDate: string | null;
  readonly qualityStatus: string;
  readonly discrepancyReason: string | null;
  readonly serialNumbers: readonly string[];
}

export interface GrnNoteModel {
  readonly organizationName: string;
  readonly grnNumber: string;
  readonly status: string;
  readonly receivedDate: string;
  readonly locationLabel: string;
  readonly poNumber: string;
  readonly vendorName: string;
  readonly vendorCode: string;
  readonly receivedBy: string;
  readonly postedBy: string | null;
  readonly lines: readonly GrnNoteLine[];
  /** PNG data URI resolving to the receipt's own number. */
  readonly stampDataUri: string;
}

/**
 * The widths are shares, not points, and they are chosen so the two columns that
 * must never truncate do not: an ISO date needs the whole ten characters to stay
 * a date, and a lot number that loses its tail matches the wrong batch. A long
 * product name truncates instead, which costs nothing — the SKU beside it is the
 * identifier.
 */
const COLUMNS: readonly DocumentColumn[] = [
  { header: "SKU", weight: 16 },
  { header: "DESCRIPTION", weight: 19 },
  { header: "LOT / BATCH", weight: 14 },
  { header: "EXPIRY", weight: 12 },
  { header: "EXPECTED", weight: 10, align: "right" },
  { header: "RECEIVED", weight: 10, align: "right" },
  { header: "UOM", weight: 6 },
  { header: "QUALITY", weight: 13 },
];

/**
 * G4 — the goods received note.
 *
 * It carries the four things the unit names — the organisation, the vendor, the
 * lines and the lots — and three more the warehouse actually signs against.
 *
 * **Expected beside received.** `inv_grn_lines.quantity_expected` is the snapshot
 * taken under the row lock at post time, precisely so a short delivery stays
 * legible after the purchase order moves on. A note that printed only what
 * arrived would make the receiver's own copy the one document that cannot answer
 * "was this short".
 *
 * **The quality status per line, and the reason where there is one.** A rejected
 * line is on the receipt and is not in stock; a note that omits the distinction
 * reads as a claim that everything on it was accepted.
 *
 * **The serials, under the line they were scanned into.** They are the evidence
 * of what physically arrived, and on a serialised delivery they are the only
 * part of the note anybody checks.
 *
 * The status is printed rather than assumed. A DRAFT receipt can be printed —
 * counters want the sheet before they post — and a piece of paper that looks
 * identical whether or not stock moved is exactly the ambiguity B1 split the
 * document lifecycle to remove.
 */
export async function buildGrnNotePdf(model: GrnNoteModel): Promise<Buffer> {
  const doc = await DocumentBuilder.create(
    `${model.grnNumber} · goods received note · generated ${new Date().toISOString().slice(0, 10)}`,
  );

  doc.header(model.organizationName, "Goods Received Note", model.grnNumber);
  doc.facts([
    ["RECEIVED DATE", model.receivedDate],
    ["STATUS", model.status],
    ["PURCHASE ORDER", model.poNumber],
    ["RECEIVING LOCATION", model.locationLabel],
    ["VENDOR", `${model.vendorName} (${model.vendorCode})`],
    ["RECEIVED BY", model.receivedBy],
    ["POSTED BY", model.postedBy ?? "Not posted"],
    ["LINES", String(model.lines.length)],
  ]);

  doc.sectionTitle("Lines");
  doc.table(
    COLUMNS,
    model.lines.map((line) => [
      line.sku,
      line.description,
      line.lotNumber ?? "-",
      line.expiryDate ?? "-",
      line.quantityExpected ?? "-",
      line.quantityReceived,
      line.uom,
      line.discrepancyReason
        ? `${line.qualityStatus} / ${line.discrepancyReason}`
        : line.qualityStatus,
    ]),
  );

  const serialised = model.lines.filter((line) => line.serialNumbers.length > 0);
  if (serialised.length > 0) {
    doc.sectionTitle("Serial numbers");
    for (const line of serialised) {
      doc.note(`${line.sku}: ${line.serialNumbers.join(", ")}`);
    }
  }

  doc.note("");
  doc.note("Received by ______________________     Checked by ______________________");

  await doc.stamp(model.stampDataUri);
  return doc.finish();
}
