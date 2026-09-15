export const UNRESOLVED_ACTOR_NAME = "Former member";

export interface ActivityActorIdentity {
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  userName: string | null;
  userEmail: string | null;
}

function trimmed(value: string | null): string | null {
  const text = value?.trim();
  return text ? text : null;
}

export function resolveActivityActorName(
  identity: ActivityActorIdentity,
): string {
  const display = trimmed(identity.displayName);
  if (display) return display;

  const full =
    `${trimmed(identity.firstName) ?? ""} ${trimmed(identity.lastName) ?? ""}`.trim();
  if (full) return full;

  const account = trimmed(identity.userName);
  if (account) return account;

  const email = trimmed(identity.userEmail);
  if (email) return trimmed(email.split("@")[0] ?? null) ?? email;

  return UNRESOLVED_ACTOR_NAME;
}
