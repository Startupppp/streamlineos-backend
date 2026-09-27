/** Tokens a letter may mention even when the org has not filled them yet. */
export const OPTIONAL_LETTER_TOKENS = new Set([
  "today",
  "company.name",
  "employee.fullName",
  "employee.firstName",
  "employee.lastName",
  "role.title",
  "department.name",
  "manager.fullName",
]);

/**
 * Replace `{{token}}` markers. Known optional tokens become empty text so a
 * preview never shows `{{employee.fullName}}`. Unknown tokens stay so Save
 * can refuse a letter that still has holes.
 */
export function mergeLetterTemplate(
  bodyHtml: string,
  context: Record<string, string>,
): string {
  return bodyHtml.replace(/\{\{([^}]+)\}\}/g, (_match, raw: string) => {
    const key = raw.trim();
    const value = context[key];
    if (value) return value;
    if (OPTIONAL_LETTER_TOKENS.has(key)) return "";
    return `{{${key}}}`;
  });
}
