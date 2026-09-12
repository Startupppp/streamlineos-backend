import { PDFDocument } from "pdf-lib";
import { buildPickListPdf, type PickListModel, type PickListLine } from "./pick-list";
import { pdfPageText } from "../../../../../test/helpers/pdf-text";

/**
 * G4 — the pick list, as a sheet somebody carries.
 *
 * A pick list is used precisely where the scanner is not, so what the paper
 * says is the whole instruction. These read the rendered page for that reason.
 */

const STAMP =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function line(overrides: Partial<PickListLine> = {}): PickListLine {
  return {
    locationCode: "A-01-02",
    sku: "SKU-1",
    description: "Paracetamol 500mg",
    lotNumber: "B-2409",
    serialNumber: null,
    quantityToPick: "5",
    quantityPicked: "",
    orderNumber: "SO-0001",
    exception: null,
    ...overrides,
  };
}

function model(overrides: Partial<PickListModel> = {}): PickListModel {
  return {
    organizationName: "Acme Foods",
    pickListNumber: "PL-000123",
    status: "RELEASED",
    warehouseLabel: "Mumbai DC",
    assignedTo: "R. Sharma",
    createdAt: "2026-08-29",
    lines: [line()],
    stampDataUri: STAMP,
    ...overrides,
  };
}

async function pagesOf(m: PickListModel): Promise<string> {
  const loaded = await PDFDocument.load(await buildPickListPdf(m));
  return loaded.getPages().map(pdfPageText).join("\n");
}

describe("pick list", () => {
  /**
   * The LOT / SERIAL column renders `serialNumber ?? lotNumber`, and on a
   * serialised pick the serial is the whole instruction — it is which physical
   * unit to take off the shelf. A truncated serial does not slow the picker
   * down, it points at a set of units instead of one, and the sheet gives no
   * sign that it has done so.
   *
   * Twenty characters is the standard's limit, not a guess: GS1 application
   * identifier 21 (SERIAL) is variable length up to twenty alphanumeric
   * characters, and this module parses GS1 on the scan path.
   */
  it("prints a full-length GS1 serial without truncating it", async () => {
    const serialNumber = "SN9876543210ABCDEFGH";
    expect(serialNumber).toHaveLength(20);

    const text = await pagesOf(model({ lines: [line({ serialNumber })] }));

    expect(text).toContain(serialNumber);
  });

  it("prints a full-length GS1 lot number when the line has no serial", async () => {
    const lotNumber = "ABCD1234EFGH5678IJKL";

    const text = await pagesOf(model({ lines: [line({ lotNumber, serialNumber: null })] }));

    expect(text).toContain(lotNumber);
  });

  /**
   * The order of the rows is the pick path — `getWave` returns them in shelf
   * order and re-sorting would walk the picker back and forth across the
   * building. The builder must not reorder what it is handed.
   */
  it("keeps the lines in the order it was given", async () => {
    const text = await pagesOf(
      model({
        lines: [
          line({ locationCode: "A-01-01", sku: "FIRST" }),
          line({ locationCode: "B-02-02", sku: "SECOND" }),
          line({ locationCode: "C-03-03", sku: "THIRD" }),
        ],
      }),
    );

    expect(text.indexOf("FIRST")).toBeLessThan(text.indexOf("SECOND"));
    expect(text.indexOf("SECOND")).toBeLessThan(text.indexOf("THIRD"));
  });
});
