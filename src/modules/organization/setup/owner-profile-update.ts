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
  phone?: string;
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
  if (name) patch.name = name;
  const phone = input.phone?.trim();
  if (phone) patch.phone = phone;
  return patch;
}
