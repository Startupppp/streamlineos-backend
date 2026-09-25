import type { PublishBlocker } from "./documents-helpers";

/**
 * Nothing reads the CONTENTS of an HR file — the knowledge-base link is metadata only, which is what makes an
 * extraction pipeline, a chunk store and an SSRF surface all structurally absent. But four metadata fields ARE
 * indexed into the search vector (`kb-linked-document-search.ts`) and returned in the entry projection, and they
 * are free text a person typed. "Aadhaar 2234 5678 9012 - Ramesh" in a document's NAME reaches knowledge-base
 * search unscanned. This is the scanner for exactly those four fields, and it never carries the matched value.
 */

/** The four fields that reach the tsvector and the projection. Nothing else on `documents` is searched. */
export const SCANNED_DOCUMENT_FIELDS = ["name", "description", "category", "tags"] as const;
export type ScannedDocumentField = (typeof SCANNED_DOCUMENT_FIELDS)[number];

export type PersonalIdentifierKind = "AADHAAR" | "PAN" | "IFSC" | "BANK_ACCOUNT";

/** What was found and where — never WHAT was found. The value is the thing we are refusing to spread. */
export interface PersonalIdentifierFinding {
  field: ScannedDocumentField;
  kind: PersonalIdentifierKind;
}

export interface ScannableDocumentMetadata {
  name?: string | null;
  description?: string | null;
  category?: string | null;
  tags?: readonly string[] | null;
}

export const METADATA_PII_BLOCKER_CODE = "METADATA_HOLDS_PERSONAL_IDENTIFIER";

// Verhoeff, the checksum Aadhaar uses. Without it every 12-digit number in a filename is an Aadhaar, and a
// blocker that fires on "Policy 2019 2020 2021" is one people learn to work around.
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

/** True when the digits carry a valid Verhoeff check digit (the last digit checks the ones before it). */
export function isVerhoeffValid(digits: string): boolean {
  let check = 0;
  const reversed = [...digits].reverse();
  for (const [index, digit] of reversed.entries()) {
    const value = Number(digit);
    if (!Number.isInteger(value)) return false;
    check = VERHOEFF_D[check]![VERHOEFF_P[index % 8]![value]!]!;
  }
  return check === 0;
}

// 12 digits, optionally in groups of four, not part of a longer run. An Aadhaar never starts 0 or 1.
const AADHAAR = /(?<![\d])([2-9]\d{3})[\s-]?(\d{4})[\s-]?(\d{4})(?![\d])/g;
// Five letters, four digits, a letter — and nothing alphanumeric either side, or a longer token matches its middle.
const PAN = /(?<![A-Z0-9])[A-Z]{5}\d{4}[A-Z](?![A-Z0-9])/gi;
// Bank code, a literal zero, then the branch.
const IFSC = /(?<![A-Z0-9])[A-Z]{4}0[A-Z0-9]{6}(?![A-Z0-9])/gi;
// A bare run of digits is a purchase order, an invoice, a year range. It is an account number only when the text
// says so, and dropping that requirement is how this blocker would start refusing ordinary company documents.
const BANK_ACCOUNT_DIGITS = /(?<!\d)\d{9,18}(?!\d)/g;
const ACCOUNT_KEYWORD = /(a\s?\/\s?c|acct|account|bank)\b[^\p{L}\d]{0,12}$/iu;

function findKinds(text: string): Set<PersonalIdentifierKind> {
  const kinds = new Set<PersonalIdentifierKind>();
  const aadhaarSpans: Array<[number, number]> = [];

  for (const match of text.matchAll(AADHAAR)) {
    const digits = match[0].replace(/[\s-]/g, "");
    if (!isVerhoeffValid(digits)) continue;
    kinds.add("AADHAAR");
    aadhaarSpans.push([match.index, match.index + match[0].length]);
  }
  if (PAN.test(text)) kinds.add("PAN");
  PAN.lastIndex = 0;
  if (IFSC.test(text)) kinds.add("IFSC");
  IFSC.lastIndex = 0;

  for (const match of text.matchAll(BANK_ACCOUNT_DIGITS)) {
    const start = match.index;
    if (aadhaarSpans.some(([from, to]) => start >= from && start < to)) continue;
    if (ACCOUNT_KEYWORD.test(text.slice(Math.max(0, start - 40), start))) {
      kinds.add("BANK_ACCOUNT");
      break;
    }
  }
  return kinds;
}

/**
 * Which personal identifiers this document's searchable metadata holds. The result names the field and the kind
 * so a person can find and fix it; it never carries the matched text, because the whole point is that the text
 * must not travel any further than the row it is already in.
 */
export function scanDocumentMetadataForPii(row: ScannableDocumentMetadata): PersonalIdentifierFinding[] {
  const findings: PersonalIdentifierFinding[] = [];
  const values: Array<[ScannedDocumentField, string]> = [
    ["name", row.name ?? ""],
    ["description", row.description ?? ""],
    ["category", row.category ?? ""],
    ["tags", (row.tags ?? []).join(" ")],
  ];
  for (const [field, text] of values) {
    if (text === "") continue;
    for (const kind of findKinds(text)) findings.push({ field, kind });
  }
  return findings;
}

/**
 * The publish blocker. One blocker however many fields are involved: the message names the fields and the kinds
 * and stops there, so neither the API response nor the audit row it is recorded in repeats the identifier.
 */
export function metadataPiiBlocker(row: ScannableDocumentMetadata): PublishBlocker | null {
  const findings = scanDocumentMetadataForPii(row);
  if (findings.length === 0) return null;
  const fields = [...new Set(findings.map((finding) => finding.field))].join(", ");
  const kinds = [...new Set(findings.map((finding) => finding.kind))].join(", ");
  return {
    code: METADATA_PII_BLOCKER_CODE,
    message: `The document's searchable details (${fields}) look like they hold a personal identifier (${kinds}). Knowledge-base search reads those fields, so remove it from the document before sharing it.`,
  };
}

/** `publishBlockers` plus the metadata scan — what a document must clear before it can be shared. */
export function withMetadataPiiBlocker(blockers: PublishBlocker[], row: ScannableDocumentMetadata): PublishBlocker[] {
  const pii = metadataPiiBlocker(row);
  return pii ? [...blockers, pii] : blockers;
}
