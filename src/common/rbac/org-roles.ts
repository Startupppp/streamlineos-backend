export const ORG_MEMBER_ROLES = {
  OWNER: "OWNER",
  ORG_ADMIN: "ORG_ADMIN",
  MEMBER: "MEMBER",
} as const;

export type OrgMemberRole = (typeof ORG_MEMBER_ROLES)[keyof typeof ORG_MEMBER_ROLES];

export const ORG_MEMBER_ROLE_VALUES = [
  ORG_MEMBER_ROLES.OWNER,
  ORG_MEMBER_ROLES.ORG_ADMIN,
  ORG_MEMBER_ROLES.MEMBER,
] as const satisfies readonly OrgMemberRole[];

export function isOrgMemberRole(value: string): value is OrgMemberRole {
  return (ORG_MEMBER_ROLE_VALUES as readonly string[]).includes(value);
}
