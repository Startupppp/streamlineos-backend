export const UNRESOLVED_MEMBER_NAME = "Former member";

interface PersonNameFields {
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  accountName?: string | null;
  email?: string | null;
}

/**
 * Runs of whitespace, including the ones a paste from a document brings with it:
 * non-breaking space, the zero-width family, and the byte-order mark.
 */
const WHITESPACE_RUN = /[\s ​‌‍⁠﻿]+/gu;

/**
 * Ticket 07. Whitespace is the only thing normalised about a name. Letters, case
 * and punctuation are left exactly as the person wrote them: "QA", "McDonald",
 * "van der Berg", "O'Brien" and "de Souza-Silva" are all legal names, and a
 * title-caser is what turned QA into "Qa" across every screen (HRMS-E2E-020).
 */
export function normalizePersonNamePart(
  value: string | null | undefined,
): string | null {
  const text = value?.replace(WHITESPACE_RUN, " ").trim();
  return text ? text : null;
}

/**
 * Ticket 07. One precedence for every surface — the directory card and table,
 * the profile header, the CSV export and the profile PDF each had their own, and
 * they disagreed: the card composed first+last while the header preferred the
 * chosen account name (V-023/V-025), so one person read two ways.
 *
 * A name somebody chose outranks a composed one; a composed one outranks the
 * address.
 */
export function resolvePersonDisplayName(person: PersonNameFields): string | null {
  const display = normalizePersonNamePart(person.displayName);
  if (display) return display;

  const account = normalizePersonNamePart(person.accountName);
  if (account) return account;

  const first = normalizePersonNamePart(person.firstName);
  const last = normalizePersonNamePart(person.lastName);
  const full = [first, last].filter(Boolean).join(" ");
  if (full) return full;

  const email = normalizePersonNamePart(person.email);
  if (!email) return null;
  return normalizePersonNamePart(email.split("@")[0] ?? null) ?? email;
}
