import {
  ACTIVITY_KIND_WORDS,
  ACTIVITY_FIELDS,
  isActivityKind,
  isPartyType,
  normaliseLookupKey,
  PARTY_FIELDS,
  PIPELINE_FIELDS,
  PARTY_TYPE_WORDS,
  SUBJECT_FIELDS,
  toDateOnly,
  toMinorUnits,
  toPercentage,
  toTimestamp,
  withinStatus,
  normaliseWord,
  IMPORT_ENTITIES,
  type EntityVocabulary,
  type AnchorRule,
  type ImportEntity,
  type ImportField,
  type MatchStrategy,
} from "./import-fields";

export * from "./import-fields";

/**
 * Which entity a file is for, and what its columns can mean.
 *
 * The importer used to be party-shaped all the way down: one flat field list,
 * one synonym table, one writer. Subjects, pipelines and activities are not a
 * second importer — they are the same plan, preview, durable commit and undo
 * with the vocabulary as a parameter. This file is that parameter, and it is the
 * only place that knows what the four vocabularies say.
 *
 * Everything here is pure and testable without a database, which is deliberate:
 * "what does this column mean" is the question the whole ticket turns on, and a
 * wrong answer writes wrong data into every row of somebody's file.
 */

// ── The four vocabularies ──────────────────────────────────────────────────

const VOCABULARY: Readonly<Record<ImportEntity, EntityVocabulary>> = {
  party: {
    fields: PARTY_FIELDS,
    required: { field: "name", reason: "No name in this row, so there is nothing to create." },
    match: { kind: "fingerprint" },
    synonyms: {
      name: [
        "name", "company", "company name", "account", "account name", "organisation",
        "organization", "organisation name", "organization name", "business name",
        "customer", "customer name", "client", "client name", "company account",
      ],
      legalName: ["legal name", "registered name", "legal entity", "legal entity name", "trading name"],
      displayName: ["display name", "short name", "nickname", "friendly name", "alias"],
      email: ["email", "e mail", "email address", "primary email", "work email", "contact email", "mail"],
      phone: [
        "phone", "telephone", "phone number", "primary phone", "work phone", "mobile",
        "mobile number", "contact number", "tel", "office phone",
      ],
      website: [
        "website", "web site", "url", "web", "homepage", "company website",
        // "Company Domain Name" is HubSpot's domain field. Listed as a phrase so it
        // beats the bare "name" that also ends that header.
        "domain", "domain name", "company domain name", "web address",
        // A bare "site" is deliberately NOT here. Salesforce's "Account Site" is a
        // location label — "HQ", "Bangalore" — and `website` is one of the four
        // identifiers a row is matched on, so reading it as a URL gives every
        // account at the same office the same blocking key. "Web site" still maps,
        // because that spelling is unambiguous.
      ],
      taxNumber: ["tax number", "tax id", "vat", "vat number", "gst", "gstin", "abn", "ein", "tax registration"],
      notes: ["notes", "note", "description", "comments", "remarks", "background", "about"],
      partyType: ["type", "party type", "account type", "record type", "relationship", "category"],
      status: ["status", "state", "account status", "lifecycle stage", "stage"],
      acquisitionSource: [
        "source", "lead source", "acquisition source", "channel", "origin",
        "referral source", "how did you hear", "lead channel",
      ],
    },
    coerce(field, cell) {
      if (field === "partyType") {
        const upper = cell.trim().toUpperCase();
        if (isPartyType(upper)) return upper;
        return PARTY_TYPE_WORDS[normaliseWord(cell)] ?? null;
      }

      if (field === "status") return withinStatus(cell);
      return cell;
    },
  },

  subject: {
    fields: SUBJECT_FIELDS,
    required: { field: "title", reason: "No title in this row, so there is nothing to create." },
    /**
     * `uniq_subjects_org_type_reference` is a real unique index, so a reference
     * that already exists is the same record with certainty — no band of doubt,
     * and no second copy of a listing every time somebody re-exports.
     */
    match: {
      kind: "natural-key",
      /**
       * The reference exactly as the file spells it, case included.
       *
       * `uniq_subjects_org_type_reference` is on the raw column, so two subjects
       * with `REF-1` and `ref-1` are two subjects as far as the database is
       * concerned. Folding case here would claim an identity Postgres does not
       * agree with, and the lookup would stop being an indexed one.
       */
      keyOf: (values) => values.reference?.trim() || null,
    },
    synonyms: {
      title: [
        "title", "name", "subject", "subject name", "record name", "listing",
        "listing name", "property", "property name", "asset", "asset name",
        "item", "item name", "label",
      ],
      reference: [
        "reference", "ref", "reference number", "reference id", "code",
        "listing code", "requisition number", "requisition id", "external id",
        "external reference", "record number", "unique id", "reference code",
      ],
      status: ["status", "state", "stage", "current status", "record status", "listing status"],
    },
    coerce: (_field, cell) => cell,
  },

  pipeline: {
    fields: PIPELINE_FIELDS,
    group: "deal",
    required: { field: "name", reason: "No deal name in this row, so there is nothing to create." },
    match: { kind: "none" },
    /**
     * A deal may or may not name the customer it is with, and `deals.party_id`
     * is nullable, so an unresolved account is not a reason to refuse the row.
     */
    anchor: {
      keyOf: (values) => normaliseLookupKey(values.partyName) || null,
      required: false,
      missingReason: "",
    },
    synonyms: {
      // Deliberately no bare "name" or "title": on an Opportunities export
      // "Account Name" is the customer, and read as the deal's name every
      // opportunity in the file is renamed after the company it belongs to.
      // A bare "Name" still reaches this field through the head-noun rule.
      name: [
        "name", "title", "deal", "deal name", "opportunity", "opportunity name",
        "deal title", "opportunity title",
      ],
      stage: ["stage", "deal stage", "sales stage", "opportunity stage", "pipeline stage", "status"],
      amount: [
        "amount", "value", "deal value", "deal amount", "opportunity amount",
        "expected revenue", "total value", "revenue", "worth",
      ],
      closeDate: [
        "close date", "expected close date", "closing date", "expected close",
        "estimated close date", "won date", "close",
      ],
      probability: ["probability", "win probability", "probability percent", "likelihood", "confidence"],
      nextStep: ["next step", "next steps", "next action", "next activity"],
      notes: ["notes", "note", "description", "comments", "remarks", "details"],
      partyName: [
        "account", "account name", "company", "company name", "organisation",
        "organization", "customer", "customer name", "client", "client name",
        "associated company", "related company",
      ],
    },
    coerce(field, cell) {
      if (field === "amount") return toMinorUnits(cell);
      if (field === "closeDate") return toDateOnly(cell);
      if (field === "probability") return toPercentage(cell);
      return cell;
    },
  },

  activity: {
    fields: ACTIVITY_FIELDS,
    group: "activity",
    required: {
      field: "subject",
      reason: "No subject in this row, so there is nothing to put on a timeline.",
    },
    match: { kind: "none" },
    /**
     * Required, because `chk_activities_one_anchor` is. An activity belongs to
     * exactly one record, so a row naming none — or naming one this tenant does
     * not have — cannot be written, and the preview says so rather than the
     * commit discovering it.
     */
    anchor: {
      keyOf: (values) => normaliseLookupKey(values.partyName) || null,
      required: true,
      missingReason:
        "No record in this organisation matches the company this row names, " +
        "so there is no timeline to put it on.",
    },
    synonyms: {
      kind: ["type", "activity type", "kind", "task type", "activity kind", "record type"],
      subject: [
        "subject", "summary", "title", "topic", "subject line",
        "activity subject", "task subject", "regarding",
      ],
      body: [
        "body", "description", "comments", "notes", "details", "message",
        "note", "comment", "remarks", "content",
      ],
      occurredAt: [
        "date", "activity date", "occurred at", "occurred", "date and time",
        "start date", "start time", "call date", "meeting date", "completed date",
        "logged at", "timestamp", "sent at", "activity time",
        // Found by driving a real activities file through the live endpoint:
        // "Happened At" is the header an exporter writes and none of the above
        // matched it, so the column silently arrived unmapped.
        "happened at", "happened on", "happened",
      ],
      dueAt: ["due date", "due at", "due", "deadline", "task due date", "due date only"],
      partyName: [
        "related to", "regarding record", "account", "account name", "company",
        "company name", "organisation", "organization", "customer", "client",
        "associated company",
      ],
    },
    coerce(field, cell) {
      if (field === "kind") {
        const lower = cell.trim().toLowerCase();
        if (isActivityKind(lower)) return lower;
        return ACTIVITY_KIND_WORDS[normaliseWord(cell)] ?? null;
      }

      if (field === "occurredAt" || field === "dueAt") return toTimestamp(cell);
      return cell;
    },
  },
};

// ── What the rest of the module asks the registry ──────────────────────────

export function vocabularyOf(entity: ImportEntity): EntityVocabulary {
  return VOCABULARY[entity];
}

export function fieldsFor(entity: ImportEntity): readonly ImportField[] {
  return VOCABULARY[entity].fields;
}

export function synonymsFor(entity: ImportEntity, field: ImportField): readonly string[] {
  return VOCABULARY[entity].synonyms[field] ?? [];
}

export function groupOf(entity: ImportEntity): string | undefined {
  return VOCABULARY[entity].group;
}

export function requiredFieldOf(entity: ImportEntity): { field: ImportField; reason: string } {
  return VOCABULARY[entity].required;
}

export function coerceFor(entity: ImportEntity): (field: ImportField, cell: string) => string | null {
  return (field, cell) => VOCABULARY[entity].coerce(field, cell);
}

export function matchStrategyFor(entity: ImportEntity): MatchStrategy {
  return VOCABULARY[entity].match;
}

export function anchorOf(entity: ImportEntity): AnchorRule | undefined {
  return VOCABULARY[entity].anchor;
}

export function isFieldOf(entity: ImportEntity, value: string): value is ImportField {
  return (VOCABULARY[entity].fields as readonly string[]).includes(value);
}

/**
 * Every field any entity has, which is what an override may legally name.
 *
 * The DTO validates against this and `applyOverrides` narrows against the
 * entity's own list, so naming a real field that belongs to a different entity
 * is refused with a sentence rather than accepted and dropped.
 */
export const ALL_IMPORT_FIELDS: readonly ImportField[] = [
  ...new Set<ImportField>(IMPORT_ENTITIES.flatMap((entity) => [...VOCABULARY[entity].fields])),
];

/**
 * The fields that decide WHICH party a row is, rather than what it says.
 *
 * Party-only, and that is the point: these are the keys the duplicate scorer
 * blocks and matches on, so a value belonging to somebody else landing in one
 * does not produce a slightly wrong record but the wrong record. The mapping
 * evals gate on exactly this set.
 */
export const IDENTITY_FIELDS: readonly ImportField[] = [
  "name",
  "legalName",
  "email",
  "phone",
  "taxNumber",
  "website",
];
