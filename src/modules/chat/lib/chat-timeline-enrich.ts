import { and, eq } from "drizzle-orm";
import { chatChannelMembers } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { EntityReferenceService } from "../../entity-reference/entity-reference.service";
import type { EntityActor } from "../../entity-reference/entity-reference.types";
import {
  resolvePeopleIdentities,
  subjectKey,
  type PersonIdentity,
} from "../../directory/person-seam";

/**
 * Turning stored chat rows into rows a client can render.
 *
 * All three readers next door — the channel timeline, the poll and the thread
 * replies — call the same four: check membership, resolve the senders, resolve
 * any entity references in the body, and shape the result. Grouping them is
 * what stops the three from drifting: a sender projected one way in the
 * timeline and another in a thread reply is the sort of difference nobody sees
 * until a name is missing on one screen.
 *
 * `senderFromIdentity` is the projection the actor cutover requires: the row
 * stores a membership id, and the person's name and avatar are reached through
 * the directory seam rather than a relation to global `users`.
 */

type ChatSender = {
  id: string | null;
  name: string | null;
  image: string | null;
};

function senderFromIdentity(identity: PersonIdentity | undefined): ChatSender {
  const parts = [identity?.firstName, identity?.lastName]
    .filter(Boolean)
    .join(" ");
  const name = identity?.displayName ?? (parts || null);
  return {
    id: identity?.userId ?? null,
    name: name ?? null,
    image: identity?.avatarUrl ?? null,
  };
}

export async function isMember(
  db: Db,
  channelId: number,
  orgId: string,
  membershipId?: number | null,
): Promise<boolean> {
  if (!membershipId) return false;
  const m = await db.query.chatChannelMembers.findFirst({
    where: and(
      eq(chatChannelMembers.orgId, orgId),
      eq(chatChannelMembers.channelId, channelId),
      eq(chatChannelMembers.membershipId, membershipId),
    ),
    columns: { id: true },
  });
  return Boolean(m);
}

export function withResolvedReferences<
  T extends { metadata: Record<string, unknown> | null },
>(
  entities: EntityReferenceService,
  actor: EntityActor,
  messages: T[],
): Promise<T[]> {
  return entities.withResolvedReferences(actor, messages);
}

export async function resolveIdentities(
  db: Db,
  orgId: string,
  senderIds: Set<string>,
): Promise<Map<string, PersonIdentity>> {
  if (senderIds.size === 0) return new Map();
  const subjects = [...senderIds].map((userId) => ({
    kind: "user" as const,
    userId,
  }));
  return resolvePeopleIdentities(db, orgId, subjects);
}

export function enrich<
  M extends {
    senderMembership: { userId: string } | null;
    replyTo:
      | ({ senderMembership: { userId: string } | null } & Record<
          string,
          unknown
        >)
      | null;
  },
>(msg: M, identities: Map<string, PersonIdentity>) {
  return {
    ...msg,
    sender: senderFromIdentity(
      msg.senderMembership
        ? identities.get(
            subjectKey({ kind: "user", userId: msg.senderMembership.userId }),
          )
        : undefined,
    ),
    replyTo: msg.replyTo
      ? {
          ...msg.replyTo,
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
