/**
 * Header rows as the competing products actually emit them.
 *
 * These are the export column labels from four CRMs, transcribed rather than
 * invented — the awkward ones are awkward because those products really do spell
 * them that way. Four exports each, not one: a tenant leaving Salesforce brings
 * Accounts, Contacts, Opportunities and Tasks, and pastes all four into the same
 * importer, so a dataset that only covers the Accounts file measures a quarter
 * of what the importer is asked to read.
 *
 * `expected` is what each header must map to. `null` means the column is
 * deliberately not imported (another system's identifiers and timestamps), and
 * `"custom"` means it must survive as a custom field rather than be dropped.
 *
 * ── Why `identityTrap` is a field and not a comment ────────────────────────
 *
 * A header carrying an identity attribute — a name, an e-mail address, a phone
 * number, a website or a tax number — that belongs to somebody OTHER than the
 * row is the one mistake this importer must never make. `Account Owner Email` is
 * a sales rep, `Asst. Phone` is a receptionist fifty contacts share, and
 * `Parent Account` is a different company. Read as the row's own identity, each
 * hands the same identifier to every row that mentions the same rep, receptionist
 * or parent — and rows sharing an identifier are exactly what the duplicate
 * scorer merges above 0.85. One customer becomes another, a file at a time.
 *
 * The flag is a property of the HEADER, decidable by reading it against the
 * product that emits it, and deliberately not a property of what our mapper
 * currently does with it. A marker defined by the code under test measures the
 * code's own opinion of itself.
 */

/** Which product's export a header was transcribed from. */
export type ColumnProduct = "salesforce" | "hubspot" | "zoho" | "pipedrive" | "generic";

/**
 * Which export of that product.
 *
 * Recorded because it is the thing the header alone cannot tell you, and the
 * suite asserts coverage per export: a dataset that drifts back to being all
 * Accounts columns would otherwise keep its numbers and quietly stop testing
 * three quarters of what people paste in.
 */
export type ColumnSource = "accounts" | "contacts" | "deals" | "activities" | "any";

export interface ColumnCase {
  readonly product: ColumnProduct;
  readonly source: ColumnSource;
  readonly header: string;
  readonly expected: string | null | "custom";
  /**
   * This header carries an identity attribute belonging to another record or
   * another person. It must never land in an identity column.
   */
  readonly identityTrap?: true;
}

export const COLUMN_MAPPING_DATASET: readonly ColumnCase[] = [
  // ── Salesforce ──────────────────────────────────────────────────────────
  // Accounts
  { product: "salesforce", source: "accounts", header: "Account Name", expected: "name" },
  { product: "salesforce", source: "accounts", header: "Account Number", expected: "custom" },
  /**
   * Salesforce's "Site" is a location label — "HQ", "Bangalore Office" — and not
   * a URL. It reads as one, which is why `website` used to claim it and why
   * every account at one office would then have shared a blocking key.
   */
  { product: "salesforce", source: "accounts", header: "Account Site", expected: "custom" },
  /** Salesforce's account `Type` is Customer / Partner / Prospect. */
  { product: "salesforce", source: "accounts", header: "Type", expected: "partyType" },
  { product: "salesforce", source: "accounts", header: "Account Owner", expected: "custom", identityTrap: true },
  {
    product: "salesforce",
    source: "accounts",
    header: "Parent Account",
    expected: "custom",
    identityTrap: true,
  },
  { product: "salesforce", source: "accounts", header: "Website", expected: "website" },
  { product: "salesforce", source: "accounts", header: "Phone", expected: "phone" },
  { product: "salesforce", source: "accounts", header: "Fax", expected: "custom" },
  { product: "salesforce", source: "accounts", header: "Description", expected: "notes" },
  { product: "salesforce", source: "accounts", header: "Account Record Type", expected: "partyType" },
  { product: "salesforce", source: "accounts", header: "Billing Street", expected: "custom" },
  { product: "salesforce", source: "accounts", header: "Annual Revenue", expected: "custom" },
  { product: "salesforce", source: "accounts", header: "Rating", expected: "custom" },
  { product: "salesforce", source: "accounts", header: "Created Date", expected: null },
  { product: "salesforce", source: "accounts", header: "Account ID", expected: null },
  { product: "salesforce", source: "accounts", header: "Last Modified Date", expected: null },

  // Contacts
  /**
   * A part of a name is not the name, and in isolation it is still the only
   * honest answer available. Both columns arrive together in the real file, and
   * `mapColumns` turns the second claimant ambiguous so a person decides which
   * one the party is called — which is why this case scores `mapColumn` alone
   * without that being the whole story.
   */
  { product: "salesforce", source: "contacts", header: "First Name", expected: "name" },
  { product: "salesforce", source: "contacts", header: "Full Name", expected: "name" },
  { product: "salesforce", source: "contacts", header: "Salutation", expected: "custom" },
  { product: "salesforce", source: "contacts", header: "Mailing Street", expected: "custom" },
  { product: "salesforce", source: "contacts", header: "Mobile Phone", expected: "phone" },
  {
    /** The receptionist's line. Several contacts at one company share it. */
    product: "salesforce",
    source: "contacts",
    header: "Asst. Phone",
    expected: "custom",
    identityTrap: true,
  },
  { product: "salesforce", source: "contacts", header: "Assistant", expected: "custom", identityTrap: true },
  { product: "salesforce", source: "contacts", header: "Contact Owner", expected: "custom", identityTrap: true },
  { product: "salesforce", source: "contacts", header: "Reports To", expected: "custom", identityTrap: true },
  { product: "salesforce", source: "contacts", header: "Lead Source", expected: "acquisitionSource" },

  // Opportunities
  {
    /** A deal's title — "Acme — 40 licences" — is not a company's name. */
    product: "salesforce",
    source: "deals",
    header: "Opportunity Name",
    expected: "custom",
    identityTrap: true,
  },
  { product: "salesforce", source: "deals", header: "Opportunity Owner", expected: "custom", identityTrap: true },
  { product: "salesforce", source: "deals", header: "Amount", expected: "custom" },
  { product: "salesforce", source: "deals", header: "Close Date", expected: null },
  { product: "salesforce", source: "deals", header: "Next Step", expected: "custom" },

  // Tasks
  { product: "salesforce", source: "activities", header: "Subject", expected: "custom" },
  /**
   * A date column, and the mapper does not see it as one: `IGNORABLE_HEAD` reads
   * the LAST word and Salesforce puts "Only" after it. Recorded as `null`
   * anyway, because what the column IS does not depend on what we manage to
   * work out about it — an expectation written to match the answer would make
   * this row measure nothing. It costs a visible custom field, which is the
   * cheap end of being wrong, and it is why recall is not 1.0.
   */
  { product: "salesforce", source: "activities", header: "Due Date Only", expected: null },
  { product: "salesforce", source: "activities", header: "Priority", expected: "custom" },
  { product: "salesforce", source: "activities", header: "Related To", expected: "custom" },
  { product: "salesforce", source: "activities", header: "Comments", expected: "notes" },

  // ── HubSpot ─────────────────────────────────────────────────────────────
  // Companies
  { product: "hubspot", source: "accounts", header: "Company name", expected: "name" },
  { product: "hubspot", source: "accounts", header: "Company Domain Name", expected: "website" },
  { product: "hubspot", source: "accounts", header: "Company owner", expected: "custom", identityTrap: true },
  { product: "hubspot", source: "accounts", header: "Phone Number", expected: "phone" },
  { product: "hubspot", source: "accounts", header: "Industry", expected: "custom" },
  { product: "hubspot", source: "accounts", header: "Number of Employees", expected: "custom" },
  { product: "hubspot", source: "accounts", header: "City", expected: "custom" },
  { product: "hubspot", source: "accounts", header: "Postal Code", expected: "custom" },
  { product: "hubspot", source: "accounts", header: "Country/Region", expected: "custom" },
  { product: "hubspot", source: "accounts", header: "Linkedin Company Page", expected: "custom" },
  { product: "hubspot", source: "accounts", header: "Record ID", expected: null },
  { product: "hubspot", source: "accounts", header: "Create Date", expected: null },
  { product: "hubspot", source: "accounts", header: "Last Activity Date", expected: null },

  // Contacts
  { product: "hubspot", source: "contacts", header: "Contact owner", expected: "custom", identityTrap: true },
  {
    /** The company this contact belongs to, on a file of contacts. */
    product: "hubspot",
    source: "contacts",
    header: "Associated Company",
    expected: "custom",
    identityTrap: true,
  },
  { product: "hubspot", source: "contacts", header: "Associated Company IDs", expected: null },
  { product: "hubspot", source: "contacts", header: "Job Title", expected: "custom" },
  { product: "hubspot", source: "contacts", header: "Lifecycle Stage", expected: "status" },
  { product: "hubspot", source: "contacts", header: "Lead Status", expected: "status" },
  { product: "hubspot", source: "contacts", header: "Mobile Phone Number", expected: "phone" },
  { product: "hubspot", source: "contacts", header: "Street Address", expected: "custom" },

  // Deals
  {
    product: "hubspot",
    source: "deals",
    header: "Deal Name",
    expected: "custom",
    identityTrap: true,
  },
  { product: "hubspot", source: "deals", header: "Deal Stage", expected: "custom" },
  { product: "hubspot", source: "deals", header: "Deal owner", expected: "custom", identityTrap: true },
  { product: "hubspot", source: "deals", header: "Pipeline", expected: "custom" },
  { product: "hubspot", source: "deals", header: "Deal Type", expected: "custom" },
  { product: "hubspot", source: "deals", header: "Associated Contact", expected: "custom", identityTrap: true },

  // Engagements
  { product: "hubspot", source: "activities", header: "Activity Type", expected: "custom" },
  { product: "hubspot", source: "activities", header: "Activity Date", expected: null },
  { product: "hubspot", source: "activities", header: "Activity assigned to", expected: "custom", identityTrap: true },

  // ── Zoho CRM ────────────────────────────────────────────────────────────
  // Accounts
  { product: "zoho", source: "accounts", header: "Account Name", expected: "name" },
  { product: "zoho", source: "accounts", header: "Email", expected: "email" },
  { product: "zoho", source: "accounts", header: "Website", expected: "website" },
  { product: "zoho", source: "accounts", header: "GSTIN", expected: "taxNumber" },
  { product: "zoho", source: "accounts", header: "Tax ID", expected: "taxNumber" },
  { product: "zoho", source: "accounts", header: "Account Type", expected: "partyType" },
  { product: "zoho", source: "accounts", header: "Employees", expected: "custom" },
  { product: "zoho", source: "accounts", header: "Ownership", expected: "custom" },
  /** Zoho spells it with a lowercase d; HubSpot writes "Record ID". */
  { product: "zoho", source: "accounts", header: "Record Id", expected: null },
  {
    product: "zoho",
    source: "accounts",
    header: "Parent Account",
    expected: "custom",
    identityTrap: true,
  },
  { product: "zoho", source: "accounts", header: "Account Owner", expected: "custom", identityTrap: true },
  { product: "zoho", source: "accounts", header: "Modified Time", expected: null },
  { product: "zoho", source: "accounts", header: "Created Time", expected: null },

  // Contacts
  { product: "zoho", source: "contacts", header: "Contact Name", expected: "name" },
  { product: "zoho", source: "contacts", header: "Secondary Email", expected: "email" },
  { product: "zoho", source: "contacts", header: "Mobile", expected: "phone" },
  { product: "zoho", source: "contacts", header: "Department", expected: "custom" },

  // Deals
  {
    product: "zoho",
    source: "deals",
    header: "Deal Name",
    expected: "custom",
    identityTrap: true,
  },
  { product: "zoho", source: "deals", header: "Deal Owner", expected: "custom", identityTrap: true },
  { product: "zoho", source: "deals", header: "Expected Revenue", expected: "custom" },
  { product: "zoho", source: "deals", header: "Closing Date", expected: null },

  // Tasks
  { product: "zoho", source: "activities", header: "Task Owner", expected: "custom", identityTrap: true },
  { product: "zoho", source: "activities", header: "Due Date", expected: null },

  // ── Pipedrive ───────────────────────────────────────────────────────────
  // Organizations. Every Pipedrive header is `Entity - Field`, which is why the
  // entity half matters: it says which record the field belongs to.
  { product: "pipedrive", source: "accounts", header: "Organization - Name", expected: "name" },
  { product: "pipedrive", source: "accounts", header: "Organization - Address", expected: "custom" },
  { product: "pipedrive", source: "accounts", header: "Organization - Owner", expected: "custom", identityTrap: true },
  { product: "pipedrive", source: "accounts", header: "Organization - Label", expected: "custom" },
  { product: "pipedrive", source: "accounts", header: "Organization - People count", expected: "custom" },
  { product: "pipedrive", source: "accounts", header: "Organization - Open deals", expected: "custom" },
  /**
   * A timestamp with no date word in it, which is why `IGNORABLE_HEAD` had to
   * learn "created": every other product writes "Created Date" or "Created
   * Time" and Pipedrive writes this.
   */
  { product: "pipedrive", source: "accounts", header: "Organization - Created", expected: null },
  { product: "pipedrive", source: "accounts", header: "Organization - ID", expected: null },
  { product: "pipedrive", source: "accounts", header: "Organization - Update time", expected: null },

  // Persons
  { product: "pipedrive", source: "contacts", header: "Person - Name", expected: "name" },
  { product: "pipedrive", source: "contacts", header: "Person - Email", expected: "email" },
  { product: "pipedrive", source: "contacts", header: "Person - Phone", expected: "phone" },
  {
    /**
     * The company the person works at. Read as the party's own name, every
     * person at one company collapses into that company.
     */
    product: "pipedrive",
    source: "contacts",
    header: "Person - Organization",
    expected: "custom",
    identityTrap: true,
  },
  { product: "pipedrive", source: "contacts", header: "Person - Owner", expected: "custom", identityTrap: true },
  { product: "pipedrive", source: "contacts", header: "Person - ID", expected: null },

  // Deals
  { product: "pipedrive", source: "deals", header: "Deal - Title", expected: "custom" },
  { product: "pipedrive", source: "deals", header: "Deal - Value", expected: "custom" },
  { product: "pipedrive", source: "deals", header: "Deal - Stage", expected: "custom" },
  { product: "pipedrive", source: "deals", header: "Deal - Owner", expected: "custom", identityTrap: true },
  {
    product: "pipedrive",
    source: "deals",
    header: "Deal - Organization",
    expected: "custom",
    identityTrap: true,
  },
  { product: "pipedrive", source: "deals", header: "Deal - Contact person", expected: "custom", identityTrap: true },
  { product: "pipedrive", source: "deals", header: "Deal - Expected close date", expected: null },

  // Activities
  { product: "pipedrive", source: "activities", header: "Activity - Subject", expected: "custom" },
  { product: "pipedrive", source: "activities", header: "Activity - Type", expected: "custom" },
  { product: "pipedrive", source: "activities", header: "Activity - Note", expected: "custom" },
  { product: "pipedrive", source: "activities", header: "Activity - Assigned to user", expected: "custom", identityTrap: true },
  {
    product: "pipedrive",
    source: "activities",
    header: "Activity - Organization",
    expected: "custom",
    identityTrap: true,
  },
  { product: "pipedrive", source: "activities", header: "Activity - Due date", expected: null },

  // ── The ones that carry the accuracy claim ──────────────────────────────
  // A qualifier before the head noun. Read wrong, every phone lands in a name.
  { product: "generic", source: "any", header: "Company Phone", expected: "phone" },
  { product: "generic", source: "any", header: "Billing Email", expected: "email" },
  { product: "generic", source: "any", header: "Customer Notes", expected: "notes" },
  // A column nobody should silently lose.
  { product: "generic", source: "any", header: "Preferred Courier", expected: "custom" },
  { product: "generic", source: "any", header: "VAT Number", expected: "taxNumber" },
  { product: "generic", source: "any", header: "Legal Name", expected: "legalName" },

  /**
   * The owner's own contact details, filed under `generic` on purpose.
   *
   * All four products expose the record's owner — `Account Owner`,
   * `Company owner`, `Organization - Owner` — and every one of those spellings
   * is transcribed above from the product that writes it. What varies is how a
   * given export tool FLATTENS that owner: some write the rep's name, some the
   * rep's e-mail address, and the exact header differs by product and by tool in
   * a way this repository has no way to check. The shape is what is being
   * measured, so it is recorded as a shape rather than attributed to a product
   * it might not belong to.
   *
   * The consequence is identical whichever spelling arrives: one rep owns two
   * hundred accounts, so two hundred rows arrive carrying one e-mail address,
   * and `email` is a blocking key.
   */
  {
    product: "generic",
    source: "any",
    header: "Owner Email",
    expected: "custom",
    identityTrap: true,
  },
  {
    product: "generic",
    source: "any",
    header: "Account Owner Email",
    expected: "custom",
    identityTrap: true,
  },
  {
    product: "generic",
    source: "any",
    header: "Account Manager Email",
    expected: "custom",
    identityTrap: true,
  },
  {
    product: "generic",
    source: "any",
    header: "Created By Email",
    expected: "custom",
    identityTrap: true,
  },
  {
    product: "generic",
    source: "any",
    header: "Assistant Phone",
    expected: "custom",
    identityTrap: true,
  },
];
