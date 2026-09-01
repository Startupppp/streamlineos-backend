export const PORTAL_AUDIENCE = "client-portal" as const;

export type PortalUserContext = {
  portalMembershipId: string;
  organizationId: string;
  partyContactId: string;
  audience: typeof PORTAL_AUDIENCE;
  sessionEpoch: number;
  userMembershipId: number | null;
};
