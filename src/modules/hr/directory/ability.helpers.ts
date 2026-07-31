import type { CurrentUserContext } from "../../../common/auth/backend-claims";

export function userCan(u: CurrentUserContext, verb: string, subject: string): boolean {
  return u.isOrgOwner || u.permissions.includes(`${subject}:${verb}`);
}
