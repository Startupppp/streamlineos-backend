import { PDFDocument } from "pdf-lib";
import { buildGrnNotePdf, type GrnNoteModel, type GrnNoteLine } from "./grn-note";
import { pdfPageText } from "../../../../../test/helpers/pdf-text";

/**
 * G4 — the goods received note, at the seam the controller calls.
 *
 * The note is signed against. What it says about a lot is what the receiver
 * believes arrived, so these read the rendered page rather than the model that
 * produced it.
 */

const STAMP =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function line(overrides: Partial<GrnNoteLine> = {}): GrnNoteLine {
  return {
    sku: "SKU-1",
    description: "Paracetamol 500mg",
    uom: "EA",
    quantityExpected: "100",
    quantityReceived: "100",
    lotNumber: "B-2409",
    expiryDate: "2027-03-15",
    qualityStatus: "ACCEPTED",
    discrepancyReason: null,
    serialNumbers: [],
    ...overrides,
  };
}

function model(overrides: Partial<GrnNoteModel> = {}): GrnNoteModel {
  return {
    organizationName: "Acme Foods",
    grnNumber: "GRN-000123",
    status: "POSTED",
    receivedDate: "2026-08-29",
    locationLabel: "Mumbai DC / Dock 2",
    poNumber: "PO-000045",
    vendorName: "Sun Pharma",
    vendorCode: "V-001",
    receivedBy: "R. Sharma",
    postedBy: "A. Iyer",
    lines: [line()],
    stampDataUri: STAMP,
    ...overrides,
  };
}

async function pagesOf(m: GrnNoteModel): Promise<string> {
  const loaded = await PDFDocument.load(await buildGrnNotePdf(m));
  return loaded.getPages().map(pdfPageText).join("\n");
}

describe("goods received note", () => {
  /**
   * The module states this rule itself: "a lot number that loses its tail
   * matches the wrong batch", and the column weights are said to be chosen so
   * that lot and expiry never truncate.
   *
   * Twenty characters is not an invented worst case. GS1 application
   * identifier 10 (BATCH/LOT) is variable length up to twenty alphanumeric
   * characters, `barcode/gs1.ts` parses AI 10 straight into `lotNumber`, and
   * `inv_lots.lot_number` is `text` with no length limit — so a scan can put
   * exactly this on a receipt.
   */
  it("prints a full-length GS1 lot number without truncating it", async () => {
    const lotNumber = "ABCD1234EFGH5678IJKL";
    expect(lotNumber).toHaveLength(20);

    const text = await pagesOf(model({ lines: [line({ lotNumber })] }));

    expect(text).toContain(lotNumber);
  });

  /** An ISO date that loses its tail stops being a date. */
  it("prints the expiry date in full", async () => {
    const text = await pagesOf(model({ lines: [line({ expiryDate: "2027-03-15" })] }));

    expect(text).toContain("2027-03-15");
  });
});
