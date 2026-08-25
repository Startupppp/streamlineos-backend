import type { SubjectFieldDefinition } from "../../db/schema/party/subjects";

/**
 * Checking a subject's values against the type its tenant declared.
 *
 * The declaration is data, so this cannot be a compile-time schema — the shape
 * is only known at runtime, and a tenant may change it while records exist. That
 * makes validation a value-level concern and worth being strict about: a subject
 * whose values drifted from its declaration renders as a form full of fields
 * nobody can save.
 *
 * Pure, so the rules are testable without a database or a tenant.
 */

export interface ValueProblem {
  readonly field: string;
  readonly message: string;
}

const NUMERIC = /^-?\d*\.?\d+$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Names the subject record already carries, so a type may not declare them.
 *
 * `title`, `reference` and `status` are columns on the subject itself. A
 * declared field sharing one of those names would appear twice in the rendered
 * form, and the platform column would win every read while the declared value
 * was the one being written -- a mismatch nobody could see and nobody could fix.
 *
 * Rejecting the name at declaration makes that unrepresentable, which is cheaper
 * than a renderer that defends against the collision at every read. Field names
 * are slug-shaped, so only the lowercase forms can ever be submitted.
 */
const RESERVED_FIELD_NAMES = new Set(["title", "reference", "status", "subjectid", "createdat"]);

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && !value.trim());
}

function checkKind(field: SubjectFieldDefinition, raw: unknown): string | null {
  const value = typeof raw === "string" ? raw.trim() : raw;

  switch (field.kind) {
    case "number":
    case "money":
      if (typeof value === "number") return Number.isFinite(value) ? null : "must be a number";
      return typeof value === "string" && NUMERIC.test(value) ? null : "must be a number";

    case "email":
      return typeof value === "string" && EMAIL.test(value) ? null : "must be an email address";

    case "date": {
      if (typeof value !== "string") return "must be a date";
      return Number.isNaN(new Date(value).getTime()) ? "must be a date" : null;
    }

    case "select":
    case "badge": {
      const allowed = (field.options ?? []).map((option) => option.value);
      if (allowed.length === 0) return null;
      // An option the type does not declare is a value no form could have
      // produced, so it is a bug or a tampered payload either way.
      return allowed.includes(String(value))
        ? null
        : `must be one of: ${allowed.join(", ")}`;
    }

    default:
      return typeof value === "string" || typeof value === "number" ? null : "must be text";
  }
}

export function validateSubjectValues(
  fields: readonly SubjectFieldDefinition[],
  values: Record<string, unknown> | null | undefined,
): ValueProblem[] {
  const problems: ValueProblem[] = [];
  const supplied = values ?? {};
  const declared = new Set(fields.map((field) => field.name));

  for (const field of fields) {
    const value = supplied[field.name];

    if (isBlank(value)) {
      if (field.required) problems.push({ field: field.name, message: `${field.label} is required` });
      continue;
    }

    const problem = checkKind(field, value);
    if (problem) problems.push({ field: field.name, message: `${field.label} ${problem}` });
  }

  /**
   * An undeclared key is rejected rather than stored.
   *
   * Silently keeping it would mean a value nothing can render, nothing can
   * search and nobody can find — and it is how a typo'd field name becomes
   * permanent data.
   */
  for (const key of Object.keys(supplied))
    if (!declared.has(key))
      problems.push({ field: key, message: `"${key}" is not a field on this type` });

  return problems;
}

/**
 * Keeps only declared fields, in declared order.
 *
 * Order matters because it is what the rendered form and detail view follow, and
 * a stored object's key order is otherwise whatever the client happened to send.
 */
export function normaliseSubjectValues(
  fields: readonly SubjectFieldDefinition[],
  values: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const supplied = values ?? {};
  const out: Record<string, unknown> = {};

  for (const field of fields) {
    const value = supplied[field.name];
    if (!isBlank(value)) out[field.name] = value;
  }

  return out;
}

/** The value the list column and search index read, per the type's titleField. */
export function deriveTitle(
  titleField: string,
  values: Record<string, unknown>,
  fallback: string,
): string {
  const value = values[titleField];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return fallback;
}

/** A type declaration is itself data, so it is checked before it is stored. */
export function validateFieldDefinitions(
  fields: readonly SubjectFieldDefinition[],
  titleField: string,
): ValueProblem[] {
  const problems: ValueProblem[] = [];
  const seen = new Set<string>();

  if (fields.length === 0)
    problems.push({ field: "fields", message: "a type must declare at least one field" });

  for (const field of fields) {
    if (!field.name?.trim()) {
      problems.push({ field: "fields", message: "every field needs a name" });
      continue;
    }
    if (seen.has(field.name))
      problems.push({ field: field.name, message: `duplicate field "${field.name}"` });
    seen.add(field.name);

    if (!field.label?.trim())
      problems.push({ field: field.name, message: `"${field.name}" needs a label` });

    if (RESERVED_FIELD_NAMES.has(field.name.toLowerCase()))
      problems.push({
        field: field.name,
        message: `"${field.name}" is reserved -- every subject already has one`,
      });

    if ((field.kind === "select" || field.kind === "badge") && !field.options?.length)
      problems.push({ field: field.name, message: `"${field.name}" needs options` });
  }

  if (!seen.has(titleField))
    problems.push({
      field: "titleField",
      message: `titleField "${titleField}" is not one of the declared fields`,
    });

  return problems;
}
