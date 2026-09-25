/**
 * The expense import contract, in one place. [V-071]
 *
 * The frontend's import dialog carries its own `TEMPLATE_COLUMNS` array
 * (`features/hr/expenses/components/import-expense-sheet.tsx`), so the template a
 * person downloads and the columns the parser actually reads could drift apart
 * without a single test failing. Everything about *which columns exist* now lives
 * here, and both the service and the frontend derive from it.
 *
 * `normalizeHeader` is the ONLY header normalizer: lowercase, then strip spaces,
 * underscores and dashes. "Payment Method", "payment_method" and "paymentMethod"
 * are therefore the same field, and a new spelling belongs in `headerAliases`,
 * not in an `||` chain at the call site.
 */

/** Every category an imported row may end up in. The frontend shows the same list. */
export const EXPENSE_IMPORT_CATEGORIES = [
  "Travel",
  "Food",
  "Office Supplies",
  "Software",
  "Hardware",
  "Marketing",
  "Entertainment",
  "Utilities",
  "Rent",
  "Insurance",
  "Salary",
  "Miscellaneous",
  "Other",
] as const;

export type ExpenseImportCategory = (typeof EXPENSE_IMPORT_CATEGORIES)[number];

const CATEGORY_BY_LOWER = new Map<string, string>(
  EXPENSE_IMPORT_CATEGORIES.map((c) => [c.toLowerCase(), c as string]),
);

/** The allowed category a written value names, or null when it names none. */
export function canonicalCategory(written: string): string | null {
  return CATEGORY_BY_LOWER.get(written.trim().toLowerCase()) ?? null;
}

export interface ExpenseImportField {
  /** The canonical key — also the key the parsed record is read by. */
  readonly key: string;
  readonly required: boolean;
  readonly sample: string;
  readonly hint: string;
  /** Extra spellings that resolve to this field. */
  readonly headerAliases?: readonly string[];
}

/**
 * The canonical column list: what the parser reads, what the downloadable
 * template writes, and what the dialog's instructions list.
 */
export const EXPENSE_IMPORT_FIELDS: readonly ExpenseImportField[] = [
  {
    key: "category",
    required: false,
    sample: "Travel",
    hint: `One of: ${EXPENSE_IMPORT_CATEGORIES.join(", ")} (blank files as Other)`,
  },
  { key: "amount", required: true, sample: "450.00", hint: "Positive number, up to 2 decimals" },
  { key: "description", required: false, sample: "Cab to client site", hint: "Text (optional)" },
  { key: "merchant", required: false, sample: "City Cabs", hint: "Vendor name (optional)" },
  {
    key: "paymentMethod",
    required: false,
    sample: "CASH",
    hint: "Cash, UPI, Company Card, … (optional)",
  },
  {
    key: "expenseDate",
    required: false,
    sample: "2026-09-20",
    hint: "YYYY-MM-DD (blank files as today)",
    headerAliases: ["date"],
  },
] as const;

/** lowercase, then drop spaces/underscores/dashes. The single header normalizer. */
export function normalizeHeader(header: string): string {
  return String(header).toLowerCase().replace(/[\s_-]+/g, "");
}

const FIELD_BY_NORMALIZED_HEADER = new Map<string, string>(
  EXPENSE_IMPORT_FIELDS.flatMap((field) =>
    [field.key, ...(field.headerAliases ?? [])].map(
      (spelling) => [normalizeHeader(spelling), field.key] as const,
    ),
  ),
);

/** The canonical field a CSV header names, or null when the column is not ours. */
export function resolveImportField(header: string): string | null {
  return FIELD_BY_NORMALIZED_HEADER.get(normalizeHeader(header)) ?? null;
}
