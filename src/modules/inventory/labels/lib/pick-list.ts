import { DocumentBuilder, type DocumentColumn } from "./document-builder";

export interface PickListLine {
  readonly locationCode: string;
  readonly sku: string;
  readonly description: string;
  readonly lotNumber: string | null;
  readonly serialNumber: string | null;
  readonly quantityToPick: string;
  readonly quantityPicked: string;
  readonly orderNumber: string | null;
  readonly exception: string | null;
}

export interface PickListModel {
  readonly organizationName: string;
  readonly pickListNumber: string;
  readonly status: string;
  readonly warehouseLabel: string;
  readonly assignedTo: string;
  readonly createdAt: string;
  readonly lines: readonly PickListLine[];
  readonly stampDataUri: string;
}

const COLUMNS: readonly DocumentColumn[] = [
  { header: "LOCATION", weight: 13 },
  { header: "SKU", weight: 15 },
  { header: "DESCRIPTION", weight: 25 },
  { header: "LOT / SERIAL", weight: 15 },
  { header: "ORDER", weight: 12 },
  { header: "TO PICK", weight: 10, align: "right" },
  { header: "PICKED", weight: 10, align: "right" },
];

/**
 * G4 — the pick list, as a sheet somebody carries.
 *
 * Ordered by location, which is not a presentation choice: `getWave` already
 * returns the lines in `ORDER BY l.code NULLS LAST, pll.id`, and that ordering is
 * the pick path. Re-sorting here — alphabetically by SKU, say — would produce a
 * document that walks the picker back and forth across the building, and would
 * do it invisibly, because the paper would look perfectly reasonable.
 *
 * Lines with no location come last and are marked, for the same reason: an
 * unallocated line is a decision waiting to be made, not a shelf to walk to.
 *
 * A "picked" column is printed even though the system will record the real
 * figure on confirmation. A paper pick list is used where the scanner is not,
 * and a sheet with nowhere to write the count is a sheet somebody writes the
 * count on anyway, in the margin, where nobody keys it in from.
 */
export async function buildPickListPdf(model: PickListModel): Promise<Buffer> {
  const doc = await DocumentBuilder.create(
    `${model.pickListNumber} · pick list · generated ${new Date().toISOString().slice(0, 10)}`,
  );

  doc.header(model.organizationName, "Pick List", model.pickListNumber);
  doc.facts([
    ["STATUS", model.status],
    ["WAREHOUSE", model.warehouseLabel],
    ["ASSIGNED TO", model.assignedTo],
    ["RAISED", model.createdAt],
    ["LINES", String(model.lines.length)],
    [
      "UNALLOCATED",
      String(model.lines.filter((line) => line.locationCode === "-").length),
    ],
  ]);

  doc.sectionTitle("Lines");
  doc.table(
    COLUMNS,
    model.lines.map((line) => [
      line.locationCode,
      line.sku,
      line.exception ? `${line.description}  [${line.exception}]` : line.description,
      line.serialNumber ?? line.lotNumber ?? "-",
      line.orderNumber ?? "-",
      line.quantityToPick,
      line.quantityPicked,
    ]),
  );

  doc.note("");
  doc.note("Picked by ______________________     Checked by ______________________");

  await doc.stamp(model.stampDataUri);
  return doc.finish();
}
