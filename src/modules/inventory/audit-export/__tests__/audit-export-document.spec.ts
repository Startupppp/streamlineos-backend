import { createHash } from "node:crypto";
import {
  AUDIT_EVENT_COLUMNS,
  AuditExportStream,
  LEDGER_COLUMNS,
  encodeManifestLine,
  encodeRowLine,
  encodeSectionHeaderLine,
  verifyAuditExportDocument,
  type AuditExportManifest,
} from "../audit-export-document";

const MANIFEST: AuditExportManifest = {
  orgId: "org_1",
  evidenceVersion: "L12.A7",
  warehouseIds: ["3", "9"],
  from: "2026-01-01",
  to: null,
  sections: ["ledger", "audit_events"],
  rowCounts: { ledger: 2, audit_events: 1 },
};

/** Two movements of the same quantity, rendered by Postgres as 18,4 numerics. */
const LEDGER_ROWS: (string | null)[][] = [
  [
    "1", "org_1", "40", "7", "RECEIPT", "ON_HAND",
    "5.0000", "0.0000", "5.0000", null, null,
    "12.5000", "62.5000", "2026-01-04", "idem-a", "purchase_order", "88",
    null, "user_1", "2026-01-04 09:15:00.123456",
  ],
  [
    "2", "org_1", "40", "7", "ISSUE", "ON_HAND",
    "-5.0000", "5.0000", "0.0000", null, null,
    "12.5000", "-62.5000", "2026-01-05", "idem-b", "sales_order", "91",
    null, "user_1", "2026-01-05 11:00:00.000000",
  ],
];

const AUDIT_ROWS: (string | null)[][] = [
  [
    "1", "org_1", "user_1", "settings.update", "inv_settings", "1",
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    null,
    "2026-01-06 08:00:00.000000",
  ],
];

async function buildDocument(manifest = MANIFEST): Promise<{ text: string; checksum: string }> {
  const parts: string[] = [];
  const stream = new AuditExportStream((chunk) => {
    parts.push(chunk.toString("utf8"));
  });

  await stream.line(encodeManifestLine(manifest));
  await stream.line(encodeSectionHeaderLine("ledger"));
  for (const row of LEDGER_ROWS) await stream.line(encodeRowLine(row));
  await stream.line(encodeSectionHeaderLine("audit_events"));
  for (const row of AUDIT_ROWS) await stream.line(encodeRowLine(row));

  return { text: parts.join(""), checksum: stream.checksum() };
}

const sha256 = (text: string): string =>
  createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

describe("audit export document", () => {
  it("pins the manifest key order in the bytes, not in an object literal", () => {
    expect(encodeManifestLine(MANIFEST)).toBe(
      '{"format":"streamlineos.inventory.audit-export","schemaVersion":1,"orgId":"org_1"' +
        ',"evidenceVersion":"L12.A7","scope":{"warehouseIds":["3","9"]}' +
        ',"filters":{"from":"2026-01-01","to":null}' +
        ',"sections":["ledger","audit_events"],"rowCounts":{"ledger":2,"audit_events":1}}',
    );
  });

  it("declares each section's columns in band, so a row array needs no key order", () => {
    expect(encodeSectionHeaderLine("ledger")).toBe(
      `{"section":"ledger","columns":${JSON.stringify(LEDGER_COLUMNS)}}`,
    );
    expect(encodeSectionHeaderLine("audit_events")).toBe(
      `{"section":"audit_events","columns":${JSON.stringify(AUDIT_EVENT_COLUMNS)}}`,
    );
  });

  it("writes a quantity as the exact text Postgres rendered, never as a number", () => {
    const line = encodeRowLine(LEDGER_ROWS[0] ?? []);
    expect(line).toContain('"5.0000"');
    expect(line).toContain('"12.5000"');
    expect(line).not.toContain(":5,");
    expect(JSON.parse(line)).toEqual(LEDGER_ROWS[0]);
  });

  it("carries no mutable ledger annotation and no audit payload", () => {
    for (const column of ["notes", "reason", "metadata"]) {
      expect(LEDGER_COLUMNS).not.toContain(column);
    }
    for (const column of ["before", "after", "metadata"]) {
      expect(AUDIT_EVENT_COLUMNS).not.toContain(column);
    }
    expect(AUDIT_EVENT_COLUMNS).toContain("before_sha256");
    expect(AUDIT_EVENT_COLUMNS).toContain("after_sha256");
    expect(AUDIT_EVENT_COLUMNS).toContain("metadata_sha256");
  });

  it("streams a checksum a verifier reproduces from the bytes alone", async () => {
    const { text, checksum } = await buildDocument();

    expect(sha256(text)).toBe(checksum);
    expect(verifyAuditExportDocument(text, checksum)).toEqual({
      ok: true,
      expectedChecksum: checksum,
      actualChecksum: checksum,
    });
  });

  it("fails verification when one exported row is altered", async () => {
    const { text, checksum } = await buildDocument();

    const tampered = text.replace('"5.0000","0.0000","5.0000"', '"6.0000","0.0000","6.0000"');
    expect(tampered).not.toBe(text);

    const verification = verifyAuditExportDocument(tampered, checksum);
    expect(verification.ok).toBe(false);
    expect(verification.actualChecksum).not.toBe(checksum);
    expect(sha256(tampered)).toBe(verification.actualChecksum);
  });

  it("fails verification when two rows are reordered but nothing is changed", async () => {
    const { text, checksum } = await buildDocument();

    const lines = text.split("\n");
    const [first, second] = [lines[2], lines[3]];
    lines[2] = second ?? "";
    lines[3] = first ?? "";

    expect(verifyAuditExportDocument(lines.join("\n"), checksum).ok).toBe(false);
  });

  it("fails verification when a row is dropped, even with the counts left alone", async () => {
    const { text, checksum } = await buildDocument();
    const lines = text.split("\n");
    lines.splice(2, 1);

    expect(verifyAuditExportDocument(lines.join("\n"), checksum).ok).toBe(false);
  });

  it("gives a different checksum to a different scope over the same rows", async () => {
    const wide = await buildDocument();
    const narrow = await buildDocument({ ...MANIFEST, warehouseIds: null });

    expect(narrow.checksum).not.toBe(wide.checksum);
  });
});
