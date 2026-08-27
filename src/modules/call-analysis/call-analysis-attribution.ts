/**
 * Whose call it was.
 *
 * Ticket 02's first criterion — "a rep sees their own analysis" — needs a rep,
 * and a call on the unified timeline does not reliably have one. This file is
 * where that gap is stated rather than papered over, because the paper would be
 * an attribution somebody gets coached on.
 *
 * What is actually available, in the order it is trusted:
 *
 * `activities.actorUserId` is set when a person logged the call themselves —
 * `activities.service.ts` writes it whenever `actorKind` is `human`. That is a
 * direct claim by the only person who knows, and it is the strongest signal
 * there is.
 *
 * `activities.assigneeUserId` is the fallback and a weaker claim: it is who owns
 * the follow-up rather than who was on the phone. It is used because on a
 * manually logged call the two are almost always the same person, and because
 * the alternative to a weak attribution here is no rep surface at all.
 *
 * And then the finding. An **ingested** call has neither. `inbound-ingress.workflow.ts`
 * files it with `actorKind: "system"`, `actorLabel: "ingress:call"` and no user,
 * because at that point in the pipeline there is no user to name — the party is
 * resolved from whoever rang, and on an inbound call that is the customer. The
 * telephony adapter refuses outbound calls outright for the same reason
 * (`outbound-unattributable`), so the channel that would carry the rep's own
 * number is the one that does not deliver. Until the event shape states its
 * direction and the workflow resolves our side of the call as well as theirs —
 * which is ticket 12's, below the ingress seam and not in this module — an
 * ingested call analyses to `repUserId: null`.
 *
 * A null rep is not hidden. It is stored, it is excluded from every rep's own
 * surface because it belongs to nobody, and it still counts in the manager
 * aggregate, which is a count of what the team's calls looked like rather than
 * of who made them.
 */

export type AttributionBasis = "logged-by" | "assignee" | "unattributed";

export interface CallActorFacts {
  /** `activities.actorKind`. Only a human's own log names a rep. */
  readonly actorKind: "human" | "system";
  readonly actorUserId: string | null;
  readonly assigneeUserId: string | null;
}

export interface CallAttribution {
  readonly repUserId: string | null;
  readonly basis: AttributionBasis;
}

export function attributeCall(facts: CallActorFacts): CallAttribution {
  if (facts.actorKind === "human" && facts.actorUserId)
    return { repUserId: facts.actorUserId, basis: "logged-by" };

  if (facts.assigneeUserId) return { repUserId: facts.assigneeUserId, basis: "assignee" };

  return { repUserId: null, basis: "unattributed" };
}
