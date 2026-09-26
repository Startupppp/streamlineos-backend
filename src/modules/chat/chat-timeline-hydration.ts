import type { Db } from "../../db/drizzle.module";
import type { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";
import { resolvePeopleIdentities, subjectKey, type PersonIdentity } from "../directory/person-seam";
import { liftSenderId } from "./chat-message-sender-shape";
import { foldReactions, type ReactionRow } from "./chat-message-reaction-shape";

type ChatSender = {
  id: string | null;
  name: string | null;
  image: string | null;
};

function senderFromIdentity(identity: PersonIdentity | undefined): ChatSender {
  const parts = [identity?.firstName, identity?.lastName]
    .filter(Boolean)
    .join(" ");
  // Ensure name is always string | null, never undefined, to match the Zod schema.
  // If identity has displayName, use it; else use joined parts if non-empty; else null.
  const name = identity?.displayName ?? (parts.length > 0 ? parts : null);
  return {
    id: identity?.userId ?? null,
    name,
    image: identity?.avatarUrl ?? null,
  };
}

function enrich<
  M extends {
    senderMembership: { userId: string } | null;
    reactions: ReactionRow[];
    replyTo:
      | ({ senderMembership: { userId: string } | null } & Record<
          string,
          unknown
        >)
      | null;
  },
>(msg: M, identities: Map<string, PersonIdentity>) {
  return {
    ...liftSenderId(msg),
    // Folded here rather than left as join rows: the wire shape is the same
    // `emoji -> userId[]` map the reaction mutation and the realtime event carry, so a
    // refetch and a live event agree about what the bubble should render.
    reactions: foldReactions(msg.reactions),
    sender: senderFromIdentity(
      msg.senderMembership
        ? identities.get(
            subjectKey({ kind: "user", userId: msg.senderMembership.userId }),
          )
        : undefined,
    ),
    replyTo: msg.replyTo
      ? {
          ...liftSenderId(msg.replyTo),
          sender: senderFromIdentity(
            msg.replyTo.senderMembership
              ? identities.get(
                  subjectKey({
                    kind: "user",
                    userId: msg.replyTo.senderMembership.userId,
                  }),
                )
              : undefined,
          ),
        }
      : null,
  };
}

/** Batches sender lookup, folds reactions, and authorizes entity cards for a timeline page. */
export async function hydrateTimelineMessages<
  M extends {
    metadata: Record<string, unknown> | null;
    senderMembership: { userId: string } | null;
    reactions: ReactionRow[];
    replyTo: ({ senderMembership: { userId: string } | null } & Record<string, unknown>) | null;
  },
>(db: Db, entities: EntityReferenceService, actor: EntityActor, messages: M[]) {
  const senderIds = new Set<string>();
  for (const message of messages) {
    if (message.senderMembership?.userId) senderIds.add(message.senderMembership.userId);
    if (message.replyTo?.senderMembership?.userId)
      senderIds.add(message.replyTo.senderMembership.userId);
  }
  const identities = senderIds.size === 0
    ? new Map<string, PersonIdentity>()
    : await resolvePeopleIdentities(
        db,
        actor.orgId,
        [...senderIds].map((userId) => ({ kind: "user" as const, userId })),
      );
  return entities.withResolvedReferences(actor, messages.map((message) => enrich(message, identities)));
}
