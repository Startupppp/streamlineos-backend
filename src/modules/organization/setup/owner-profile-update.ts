/**
 * HRMS-E2E-025. The owner appeared throughout the product as
 * `ywpkpz+7po5eetnm3vno` — the local part of the address they signed up with.
 *
 * Nothing had gone wrong at display time: `getUserDisplayName` falls back to the
 * email's local part when a person has no name, which is the right thing to do
 * with nothing to show. The gap is upstream. Sign-up collects an address and
 * nothing else, and org setup asks for the company's name, industry, size and
 * phone — never the person's. So `users.name` was null for every founder, and
 * the directory, the org chart and every export showed the fallback.
 *
 * This is the mapping from what Basics collects to the columns it writes, kept
 * separate from the transaction so it can be asserted directly: which fields are
 * written at all is the part worth pinning, since writing an empty name over a
 * real one is the failure mode that matters.
 */
export interface OwnerProfileInput {
  fullName?: string;
  phone?: string;
}

export interface OwnerProfilePatch {
  name?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

/**
 * The same split sign-up uses (`auth.service.ts`, Google sign-in): everything
 * before the first space is the given name, the rest is the family name, and a
 * single word has no family name rather than a duplicated one.
 *
 * It has to be the same rule, because the passwordless path seeds
 * `firstName = <email local part>, lastName = ""` at sign-up. Writing only
 * `users.name` here leaves every surface that composes first + last — the
 * employee detail heading, avatar initials, the profile PDF — still showing the
 * email prefix.
 */
export function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const spaceIdx = fullName.indexOf(" ");
  return spaceIdx === -1
    ? { firstName: fullName, lastName: "" }
    : { firstName: fullName.slice(0, spaceIdx), lastName: fullName.slice(spaceIdx + 1).trim() };
}

/**
 * The columns org setup may write on the owner's own user row.
 *
 * Absent and blank both mean "not supplied": a field the wizard did not send,
 * or sent as whitespace, must leave what is already stored alone. An owner who
 * has a name from an earlier sign-in does not lose it because a later setup
 * submission omitted the field.
 */
export function ownerProfileUpdate(input: OwnerProfileInput): OwnerProfilePatch {
  const patch: OwnerProfilePatch = {};
  const name = input.fullName?.trim();
  if (name) {
    patch.name = name;
    const { firstName, lastName } = splitFullName(name);
    patch.firstName = firstName;
    patch.lastName = lastName;
  }
  const phone = input.phone?.trim();
  if (phone) patch.phone = phone;
  return patch;
}
