/**
 * Header rows as the competing products actually emit them.
 *
 * The ticket asks for accuracy "against real-world exports from at least two
 * competing products". These are the account/company export headers from four,
 * transcribed rather than invented — the awkward ones are awkward because those
 * products really do spell them that way.
 *
 * `expected` is what each header must map to. `null` means the column is
 * deliberately not imported (another system's identifiers), and `"custom"`
 * means it must survive as a custom field rather than be dropped.
 */
export interface ColumnCase {
  readonly product: string;
  readonly header: string;
  readonly expected: string | null | "custom";
}

export const COLUMN_MAPPING_DATASET: readonly ColumnCase[] = [
  // ── Salesforce: Account export ──────────────────────────────────────────
  { product: "salesforce", header: "Account Name", expected: "name" },
  { product: "salesforce", header: "Account Number", expected: "custom" },
  { product: "salesforce", header: "Website", expected: "website" },
  { product: "salesforce", header: "Phone", expected: "phone" },
  { product: "salesforce", header: "Description", expected: "notes" },
  { product: "salesforce", header: "Account Record Type", expected: "partyType" },
  { product: "salesforce", header: "Billing Street", expected: "custom" },
  { product: "salesforce", header: "Created Date", expected: null },
  { product: "salesforce", header: "Account ID", expected: null },

  // ── HubSpot: Companies export ───────────────────────────────────────────
  { product: "hubspot", header: "Company name", expected: "name" },
  { product: "hubspot", header: "Company Domain Name", expected: "website" },
  { product: "hubspot", header: "Phone Number", expected: "phone" },
  { product: "hubspot", header: "Company owner", expected: "custom" },
  { product: "hubspot", header: "Industry", expected: "custom" },
  { product: "hubspot", header: "Record ID", expected: null },
  { product: "hubspot", header: "Create Date", expected: null },

  // ── Zoho CRM: Accounts export ───────────────────────────────────────────
  { product: "zoho", header: "Account Name", expected: "name" },
  { product: "zoho", header: "Email", expected: "email" },
  { product: "zoho", header: "Website", expected: "website" },
  { product: "zoho", header: "GSTIN", expected: "taxNumber" },
  { product: "zoho", header: "Account Type", expected: "partyType" },
  { product: "zoho", header: "Ownership", expected: "custom" },

  // ── Pipedrive: Organizations export ─────────────────────────────────────
  { product: "pipedrive", header: "Organization - Name", expected: "name" },
  { product: "pipedrive", header: "Organization - Address", expected: "custom" },
  { product: "pipedrive", header: "Organization - Owner", expected: "custom" },
  { product: "pipedrive", header: "Organization - ID", expected: null },

  // ── The ones that carry the accuracy claim ──────────────────────────────
  // A qualifier before the head noun. Read wrong, every phone lands in a name.
  { product: "generic", header: "Company Phone", expected: "phone" },
  { product: "generic", header: "Billing Email", expected: "email" },
  { product: "generic", header: "Customer Notes", expected: "notes" },
  // A column nobody should silently lose.
  { product: "generic", header: "Preferred Courier", expected: "custom" },
  { product: "generic", header: "VAT Number", expected: "taxNumber" },
  { product: "generic", header: "Legal Name", expected: "legalName" },
];
