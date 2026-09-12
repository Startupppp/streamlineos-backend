/** The shape the deals module hands over. Its own type so the hook stays one call. */
export interface ClosedWonDealRef {
  readonly organizationId: string;
  readonly dealId: number;
  readonly partyId: string | null;
  readonly leadPartyId: string | null;
  readonly clientId: number | null;
  readonly leadId: number | null;
  readonly valueMinor: number;
  readonly actualCloseDate: string | null;
  readonly customData: unknown;
}

export type ClosedWonOutcome =
  | { readonly status: "opened"; readonly customerLifecycleId: string }
  /** A second closed-won transition on a deal that already has a term. */
  | { readonly status: "already-open" }
  | { readonly status: "skipped"; readonly reason: "no-party" | "unusable-term" };
