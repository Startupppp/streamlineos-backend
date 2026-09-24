/**
 * "Asha Mehta Rao" → { firstName: "Asha", lastName: "Mehta Rao" }.
 *
 * `candidates` stores a first and last name while every place a name arrives
 * from — a careers form, a referral, an offer acceptance — carries one string.
 * The `"-"` placeholder for a single-word name is what `candidates.last_name`
 * (NOT NULL) has always been given, kept here so the two writers agree.
 */
export function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  const firstName = parts[0] ?? name.trim();
  return { firstName, lastName: parts.length > 1 ? parts.slice(1).join(" ") : "-" };
}
