import type { RelationshipState } from "./relationship-state";

/**
 * What a relationship state is about. Exactly one, never a type-plus-id pair.
 *
 * The same shape `TimelineAnchor` uses, minus the subject arm: a subject is a
 * record on the generic renderer rather than a counterparty, so "how quickly do
 * they reply" is not a question about one.
 */
export type RelationshipAnchor =
  | { readonly kind: "party"; readonly partyId: string }
  | { readonly kind: "deal"; readonly dealId: number };

export interface StoredRelationship {
  readonly relationshipStateId: string;
  readonly anchor: RelationshipAnchor;
  readonly state: RelationshipState;
}
