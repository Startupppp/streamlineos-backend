/**
 * The one wire shape a huddle is read in, by every route that returns one.
 *
 * `chat_huddle_participants` reaches a person only through `organization_members`, and this read
 * used to ship that join verbatim as `participants[].membership.user` while the client's
 * `HuddleParticipant` declared `user` and `userId` at the top level — and
 * `apiClient.get<Huddle | null>` is a cast, so the compiler vouched for a shape the API had never
 * sent. `membership.columns` was additionally `{}`, so `userId` was not even selected: every tile
 * read "Unknown" and `isInHuddle` was permanently false, so the huddle panel never rendered.
 *
 * The join is flattened by the same `flattenChannelMember` the channel-member routes use, so the
 * two member shapes in chat are one shape. `startedByMembership` becomes `startedByUser`, and
 * `startedBy` carries the host's USER id — the client compares it to its own user id, and the
 * membership id it used to receive could never match. `orgId`, `membershipId` and
 * `startedByMembershipId` leave the wire with them: internal join keys the client never read.
 */
import { and, eq, isNull } from "drizzle-orm";
import { chatHuddleParticipants, chatHuddles } from "../../db/schema";
import type { Db } from "../../db/drizzle.types";
import { flattenChannelMember } from "./chat-channel-member-shape";

/** Huddle columns that reach the client. `orgId` and `startedByMembershipId` deliberately do not. */
export const HUDDLE_WIRE_COLUMNS = {
  id: true,
  channelId: true,
  status: true,
  calendarEventId: true,
  meetingUrl: true,
  startedAt: true,
  endedAt: true,
} as const;

/** Participant columns that reach the client. `orgId` and `membershipId` deliberately do not. */
export const HUDDLE_PARTICIPANT_WIRE_COLUMNS = {
  id: true,
  huddleId: true,
  joinedAt: true,
  leftAt: true,
} as const;

/** Every key a huddle carries on the wire, and nothing else. */
export const HUDDLE_WIRE_KEYS = [
  "calendarEventId",
  "channelId",
  "endedAt",
  "id",
  "meetingUrl",
  "participants",
  "startedAt",
  "startedBy",
  "startedByUser",
  "status",
] as const;

/** Every key a huddle participant carries on the wire, and nothing else. */
export const HUDDLE_PARTICIPANT_WIRE_KEYS = [
  "huddleId",
  "id",
  "joinedAt",
  "leftAt",
  "user",
  "userId",
] as const;

export async function loadHuddleWire(db: Db, huddleId: number, orgId: string) {
  const row = await db.query.chatHuddles.findFirst({
    where: and(eq(chatHuddles.orgId, orgId), eq(chatHuddles.id, huddleId)),
    columns: HUDDLE_WIRE_COLUMNS,
    with: {
      participants: {
        where: isNull(chatHuddleParticipants.leftAt),
        columns: HUDDLE_PARTICIPANT_WIRE_COLUMNS,
        with: {
          membership: {
            columns: { userId: true },
            with: {
              user: { columns: { id: true, name: true, image: true } },
            },
          },
        },
      },
      startedByMembership: {
        columns: { userId: true },
        with: {
          user: { columns: { id: true, name: true } },
        },
      },
    },
  });
  if (!row) return null;
  const { startedByMembership, participants, ...huddle } = row;
  return {
    ...huddle,
    startedBy: startedByMembership?.userId ?? null,
    startedByUser: startedByMembership?.user ?? null,
    participants: participants.map(flattenChannelMember),
  };
}
