import { HttpException } from "@nestjs/common";
import {
  METADATA_PII_BLOCKER_CODE,
  isVerhoeffValid,
  metadataPiiBlocker,
  scanDocumentMetadataForPii,
} from "./document-pii-scan";
import { notPublishableError } from "../../kb/linked-documents/document-audience-targets";

/**
 * No real identifier appears in this file. The Aadhaar-shaped numbers are built here: eleven digits chosen at
 * random once, then the Verhoeff check digit COMPUTED, so the valid one is valid by construction and the invalid
 * one differs from it by exactly that digit. That is also what proves the scanner checks the checksum rather than
 * counting to twelve.
 */

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const VERHOEFF_INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

/** The check digit that makes `body` (eleven digits) a Verhoeff-valid twelve. Written out, not imported. */
function verhoeffCheckDigit(body: string): string {
  let check = 0;
  const reversed = [...body].reverse();
  for (const [index, digit] of reversed.entries()) {
    check = VERHOEFF_D[check]![VERHOEFF_P[(index + 1) % 8]![Number(digit)]!]!;
  }
  return String(VERHOEFF_INV[check]!);
}

const AADHAAR_BODY = "23456789012"; // eleven synthetic digits, never a real enrolment
const VALID_AADHAAR = AADHAAR_BODY + verhoeffCheckDigit(AADHAAR_BODY);
const INVALID_AADHAAR = AADHAAR_BODY + String((Number(verhoeffCheckDigit(AADHAAR_BODY)) + 1) % 10);

describe("the Verhoeff check the scanner rests on", () => {
  it("accepts the number it built and rejects the same number with one digit changed", () => {
    expect(VALID_AADHAAR).toHaveLength(12);
    expect(VALID_AADHAAR).not.toBe(INVALID_AADHAAR);
    expect(isVerhoeffValid(VALID_AADHAAR)).toBe(true);
    expect(isVerhoeffValid(INVALID_AADHAAR)).toBe(false);
  });
});

describe("scanning a document's searchable metadata", () => {
  const clean = { name: "Leave policy 2026", description: "How leave works", category: "POLICY", tags: ["hr"] };

  it("finds nothing in an ordinary company document", () => {
    expect(scanDocumentMetadataForPii(clean)).toEqual([]);
    expect(metadataPiiBlocker(clean)).toBeNull();
  });

  it("finds a Verhoeff-valid Aadhaar and ignores one whose check digit does not add up", () => {
    expect(scanDocumentMetadataForPii({ ...clean, name: `ID proof ${VALID_AADHAAR}` })).toEqual([
      { field: "name", kind: "AADHAAR" },
    ]);
    expect(scanDocumentMetadataForPii({ ...clean, name: `ID proof ${INVALID_AADHAAR}` })).toEqual([]);
  });

  it("finds an Aadhaar written in groups of four, in a space or a hyphen", () => {
    const spaced = `${VALID_AADHAAR.slice(0, 4)} ${VALID_AADHAAR.slice(4, 8)} ${VALID_AADHAAR.slice(8)}`;
    const hyphenated = spaced.replace(/ /g, "-");

    expect(scanDocumentMetadataForPii({ ...clean, description: spaced })).toEqual([{ field: "description", kind: "AADHAAR" }]);
    expect(scanDocumentMetadataForPii({ ...clean, tags: [hyphenated] })).toEqual([{ field: "tags", kind: "AADHAAR" }]);
  });

  it("finds a PAN and an IFSC, in any of the four fields, and not in a lookalike token", () => {
    expect(scanDocumentMetadataForPii({ ...clean, name: "Form 16 ABCDE1234F" })).toEqual([{ field: "name", kind: "PAN" }]);
    expect(scanDocumentMetadataForPii({ ...clean, tags: ["SBIN0001234"] })).toEqual([{ field: "tags", kind: "IFSC" }]);

    // One letter short, one digit short, and a PAN buried inside a longer alphanumeric token: none of them count.
    expect(scanDocumentMetadataForPii({ ...clean, name: "ABCD1234F ABCDE123F XXABCDE1234FYY" })).toEqual([]);
  });

  it("does NOT trip on a bare long number, and does once the text calls it an account", () => {
    expect(scanDocumentMetadataForPii({ ...clean, name: "Invoice 501234567890 for Q3" })).toEqual([]);
    expect(scanDocumentMetadataForPii({ ...clean, description: "Purchase order 000123456789012" })).toEqual([]);

    expect(scanDocumentMetadataForPii({ ...clean, description: "Bank account 501234567890" })).toEqual([
      { field: "description", kind: "BANK_ACCOUNT" },
    ]);
    expect(scanDocumentMetadataForPii({ ...clean, name: "Salary a/c 501234567890" })).toEqual([
      { field: "name", kind: "BANK_ACCOUNT" },
    ]);
  });

  it("names the field and the kind and never the identifier itself", () => {
    const blocker = metadataPiiBlocker({ ...clean, name: `Aadhaar ${VALID_AADHAAR}`, description: "PAN ABCDE1234F" });

    expect(blocker?.code).toBe(METADATA_PII_BLOCKER_CODE);
    expect(blocker?.message).toContain("name");
    expect(blocker?.message).toContain("AADHAAR");
    expect(blocker?.message).not.toContain(VALID_AADHAAR);
    expect(blocker?.message).not.toContain("ABCDE1234F");
  });
});

describe("the publish refusal a caller receives", () => {
  it("carries the blocker code and no part of the identifier that caused it", () => {
    const blocker = metadataPiiBlocker({ name: `Aadhaar ${VALID_AADHAAR} of Ramesh`, description: null, category: null, tags: ["ABCDE1234F"] });
    expect(blocker).not.toBeNull();

    const error: HttpException = notPublishableError([blocker!]);
    const body = error.getResponse();
    const serialised = JSON.stringify(body);

    expect(error.getStatus()).toBe(422);
    expect(serialised).toContain(METADATA_PII_BLOCKER_CODE);
    expect(serialised).not.toContain(VALID_AADHAAR);
    // Not even the digits on their own, in case a future message formats them differently.
    expect(serialised).not.toContain(VALID_AADHAAR.slice(0, 4));
    expect(serialised).not.toContain("ABCDE1234F");
    expect(serialised).not.toContain("Ramesh");
  });
});
