export const UNRESOLVED_MEMBER_NAME = "Former member";

interface PersonNameFields {
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  accountName?: string | null;
  email?: string | null;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

export function resolvePersonDisplayName(person: PersonNameFields): string | null {
  const display = trimmed(person.displayName);
  if (display) return display;

  const full = `${trimmed(person.firstName) ?? ""} ${trimmed(person.lastName) ?? ""}`.trim();
  if (full) return full;

  const account = trimmed(person.accountName);
  if (account) return account;

  const email = trimmed(person.email);
  if (!email) return null;
  return trimmed(email.split("@")[0] ?? null) ?? email;
}
