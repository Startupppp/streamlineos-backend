jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { z } from "zod";
import { ChatHuddlesService } from "../chat-huddles.service";
import { HUDDLE_PARTICIPANT_WIRE_KEYS, HUDDLE_WIRE_KEYS } from "../chat-huddle-wire-shape";
import { huddleWireSchema } from "../dto/chat-misc-response.schemas";
import { primeRelocationTrafficTracker } from "../../../common/relocation/relocation-traffic-tracker";
import { type Db } from "../../../db/drizzle.module";

/**
 * The huddle payload, asserted on what the read paths RETURN — not on what a caller declares.
 *
 * `hooks/api/chat-huddles.ts` reads the active huddle through `apiClient.get<Huddle | null>(...)`,
 * a cast. The client's `HuddleParticipant` has always declared `user` and `userId` at the top level
 * and `Huddle.startedByUser`; the service shipped `participants[].membership.user` and
 * `startedByMembership.user`, with `membership: { columns: {} }` so `userId` was not selected at
 * all. A typecheck of either repo passed with the two shapes in open disagreement — which is
 * exactly the class of defect a typecheck cannot see, so nothing here relies on one.
 *
 * Every assertion drives the real `getActiveHuddle` / `startHuddle` with a database double that
 * answers in the NESTED shape the Drizzle relational query actually produces.
 */

const ORG = "org-1";
const CHANNEL = 7;
const HUDDLE = 42;
const CALENDAR_EVENT = 5;
const MEET = "https://meet.google.com/abc-defg-hij";
const ME = "user-me";
const OTHER = "user-other";
const HOST_MEMBERSHIP = 11;

const WIRE_KEYS = [...HUDDLE_WIRE_KEYS];
const PARTICIPANT_KEYS = [...HUDDLE_PARTICIPANT_WIRE_KEYS];

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort();
}

/** A participant row exactly as `with: { membership: { with: { user } } }` hands it back. */
function nestedParticipantRow(userId: string | null, id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    huddleId: HUDDLE,
    joinedAt: new Date("2026-09-01T10:00:00Z"),
    leftAt: null,
    membership:
      userId === null
        ? null
        : {
            userId,
            user: { id: userId, name: userId === ME ? "Me" : "Ada Lovelace", image: null },
          },
    ...over,
  };
}

/** The huddle row as the driver hands it back, before the flatten. */
function nestedHuddleRow(participants: ReturnType<typeof nestedParticipantRow>[]) {
  return {
    id: HUDDLE,
    channelId: CHANNEL,
    status: "active",
    calendarEventId: CALENDAR_EVENT,
    meetingUrl: MEET,
    startedAt: new Date("2026-09-01T10:00:00Z"),
    endedAt: null,
    participants,
    startedByMembership: { userId: OTHER, user: { id: OTHER, name: "Ada Lovelace" } },
  };
}

/** The columns-only huddle row `getActiveHuddle` reads first for its staleness checks. */
const staleCheckRow = {
  id: HUDDLE,
  channelId: CHANNEL,
  startedByMembershipId: HOST_MEMBERSHIP,
  status: "active",
  calendarEventId: CALENDAR_EVENT,
  startedAt: new Date(),
  endedAt: null,
};

interface DoubleOptions {
  existingHuddleInTransaction?: boolean;
}

function makeDb(wireRow: unknown, options: DoubleOptions = {}) {
  const huddleFindFirst = jest.fn();
  if (options.existingHuddleInTransaction) huddleFindFirst.mockResolvedValueOnce({ id: HUDDLE });
  else huddleFindFirst.mockResolvedValueOnce(staleCheckRow);
  huddleFindFirst.mockResolvedValueOnce(wireRow);

  const chain: Record<string, unknown> = {};
  for (const method of ["insert", "values", "update", "set", "delete", "select", "from", "orderBy", "innerJoin"])
    chain[method] = jest.fn(() => chain);
  chain.where = jest.fn(() => Promise.resolve([]));
  chain.limit = jest.fn(() => Promise.resolve([]));
  chain.onConflictDoUpdate = jest.fn(() => Promise.resolve([]));
  chain.onConflictDoNothing = jest.fn(() => Promise.resolve([]));
  chain.returning = jest.fn(() => Promise.resolve([{ id: HUDDLE }]));
  chain.execute = jest.fn(() => Promise.resolve([]));
  chain.transaction = jest.fn((cb: (tx: unknown) => Promise<unknown>) => cb(chain));
  chain.query = {
    chatHuddles: { findFirst: huddleFindFirst },
    chatChannels: {
      findFirst: jest
        .fn()
        .mockResolvedValueOnce({ isArchived: false })
        .mockResolvedValue({ name: "general" }),
    },
    chatChannelMembers: { findFirst: jest.fn().mockResolvedValue({ membershipId: 1 }), findMany: jest.fn().mockResolvedValue([]) },
    chatHuddleParticipants: { findMany: jest.fn().mockResolvedValue([{ id: 1 }]) },
    organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
  };
  return chain as unknown as Db;
}

function build(db: Db) {
  return new ChatHuddlesService(
    db,
    { publishHuddleEvent: jest.fn(), publishToUser: jest.fn() } as never,
    { log: jest.fn() } as never,
    { getSettings: jest.fn().mockResolvedValue({ maxHuddleParticipants: 50 }) } as never,
    { resolveTier: jest.fn().mockResolvedValue({ tier: "PAID", plan: "STARTER" }) } as never,
    { emit: jest.fn().mockResolvedValue({}) } as never,
    { isConfigured: () => true, executeTool: jest.fn() } as never,
  );
}

beforeEach(() => primeRelocationTrafficTracker([], Date.now()));

describe("chat huddle — one wire shape, with the identity at the top level", () => {
  it("GET /chat/channels/:id/huddle puts the user on the participant, not under membership", async () => {
    const db = makeDb(nestedHuddleRow([nestedParticipantRow(ME, 1), nestedParticipantRow(OTHER, 2)]));
    const huddle = await build(db).getActiveHuddle(CHANNEL, ME, ORG);

    expect(huddle).not.toBeNull();
    expect(sortedKeys(huddle ?? {})).toEqual(WIRE_KEYS);
    const participant = huddle?.participants[0];
    expect(participant).toBeDefined();
    expect(sortedKeys(participant ?? {})).toEqual(PARTICIPANT_KEYS);
    expect(participant).not.toHaveProperty("membership");
    expect(participant?.userId).toBe(ME);
    expect(participant?.user?.id).toBe(ME);
    expect(participant?.user?.name).toBe("Me");
  });

  it("carries the Google Meet link — it is the only way into the call", async () => {
    const db = makeDb(nestedHuddleRow([nestedParticipantRow(ME, 1)]));
    const huddle = await build(db).getActiveHuddle(CHANNEL, ME, ORG);

    expect(huddle?.meetingUrl).toBe(MEET);
    expect(WIRE_KEYS).toContain("meetingUrl");
  });

  it("carries no per-peer media state: mute, hand and screen share left with the mesh", async () => {
    const db = makeDb(nestedHuddleRow([nestedParticipantRow(ME, 1)]));
    const participant = (await build(db).getActiveHuddle(CHANNEL, ME, ORG))?.participants[0];

    expect(participant).not.toHaveProperty("isMuted");
    expect(participant).not.toHaveProperty("handRaised");
    expect(participant).not.toHaveProperty("isScreenSharing");
  });

  it("renames startedByMembership to startedByUser and answers startedBy as a USER id", async () => {
    const db = makeDb(nestedHuddleRow([nestedParticipantRow(OTHER, 2)]));
    const huddle = await build(db).getActiveHuddle(CHANNEL, ME, ORG);

    expect(huddle).not.toHaveProperty("startedByMembership");
    expect(huddle).not.toHaveProperty("startedByMembershipId");
    expect(huddle?.startedByUser).toEqual({ id: OTHER, name: "Ada Lovelace" });
    expect(huddle?.startedBy).toBe(OTHER);
    expect(typeof huddle?.startedBy).toBe("string");
  });

  it("keeps the tenant key and the internal join ids off the wire entirely", async () => {
    const db = makeDb(nestedHuddleRow([nestedParticipantRow(ME, 1)]));
    const huddle = await build(db).getActiveHuddle(CHANNEL, ME, ORG);

    expect(huddle).not.toHaveProperty("orgId");
    expect(huddle?.participants[0]).not.toHaveProperty("orgId");
    expect(huddle?.participants[0]).not.toHaveProperty("membershipId");
  });

  it("POST /chat/channels/:id/huddle/start emits the identical key set, so start and read cannot disagree", async () => {
    const db = makeDb(nestedHuddleRow([nestedParticipantRow(ME, 1)]), { existingHuddleInTransaction: true });
    const started = await build(db).startHuddle(CHANNEL, ME, ORG);

    expect(sortedKeys(started ?? {})).toEqual(WIRE_KEYS);
    expect(sortedKeys(started?.participants[0] ?? {})).toEqual(PARTICIPANT_KEYS);
    expect(started?.participants[0]?.userId).toBe(ME);
  });

  it("a participant whose organization row is gone flattens to nulls, never to a missing key", async () => {
    const db = makeDb(nestedHuddleRow([nestedParticipantRow(null, 3)]));
    const participant = (await build(db).getActiveHuddle(CHANNEL, ME, ORG))?.participants[0];

    expect(participant?.userId).toBeNull();
    expect(participant?.user).toBeNull();
    expect(participant && "user" in participant).toBe(true);
    expect(participant && "userId" in participant).toBe(true);
  });

  it("selects membership.userId — the pre-fix query asked for no membership columns at all", async () => {
    const db = makeDb(nestedHuddleRow([nestedParticipantRow(ME, 1)]));
    await build(db).getActiveHuddle(CHANNEL, ME, ORG);

    const [, wireQuery] = (db.query.chatHuddles.findFirst as unknown as jest.Mock).mock.calls;
    const participantsWith = wireQuery?.[0]?.with?.participants?.with?.membership;
    expect(participantsWith?.columns).toEqual({ userId: true });
    expect(wireQuery?.[0]?.with?.startedByMembership?.columns).toEqual({ userId: true });
  });
});

/**
 * The declared contract, parsed against the value the handler actually returns.
 *
 * `ResponseContractInterceptor` throws under NODE_ENV=test and logs everywhere else, so a
 * `@ResponseSchema` that disagrees with the payload is a per-request error line in production
 * and nothing at all in a typecheck. `calendarEventId` was declared `z.string().nullable()`
 * against an `integer` column, so every huddle that owned a calendar event violated it.
 */
describe("chat huddle — huddleWireSchema parses the payload the service returns", () => {
  it("accepts the served huddle, meeting link and integer calendar event id included", async () => {
    const db = makeDb(nestedHuddleRow([nestedParticipantRow(ME, 1), nestedParticipantRow(OTHER, 2)]));
    const huddle = await build(db).getActiveHuddle(CHANNEL, ME, ORG);

    const parsed = huddleWireSchema.safeParse(huddle);
    expect(parsed.success).toBe(true);
  });

  it("BITE: the previous string-typed calendarEventId rejects the integer the column holds", async () => {
    const db = makeDb(nestedHuddleRow([nestedParticipantRow(ME, 1)]));
    const huddle = await build(db).getActiveHuddle(CHANNEL, ME, ORG);

    const previous = huddleWireSchema.extend({ calendarEventId: z.string().nullable() });
    const parsed = previous.safeParse(huddle);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.path.join("."))).toContain("calendarEventId");
  });

  it("BITE: a huddle with no meeting link is representable on the wire but is not silently absent", async () => {
    const row = { ...nestedHuddleRow([nestedParticipantRow(ME, 1)]), meetingUrl: null };
    const db = makeDb(row);
    const huddle = await build(db).getActiveHuddle(CHANNEL, ME, ORG);

    expect(huddleWireSchema.safeParse(huddle).success).toBe(true);
    expect(huddle && "meetingUrl" in huddle).toBe(true);
    expect(huddle?.meetingUrl).toBeNull();
  });

  it("BITE: a non-URL meeting link is refused rather than shipped as a dead join button", async () => {
    const row = { ...nestedHuddleRow([nestedParticipantRow(ME, 1)]), meetingUrl: "not-a-url" };
    const db = makeDb(row);
    const huddle = await build(db).getActiveHuddle(CHANNEL, ME, ORG);

    expect(huddleWireSchema.safeParse(huddle).success).toBe(false);
  });
});

/**
 * The consumer predicates, run against the real payload.
 *
 * These live readers of a huddle participant:
 * `huddle-participant-card.tsx:81` renders `participant.user?.name ?? "Unknown"`,
 * `use-message-panel-data.ts:92` decides `isInHuddle` by `p.userId === currentUserId` — which gates
 * whether the huddle panel renders at all — and `huddle-panel.tsx:68` decides `isHost` by
 * `huddle.startedBy === currentUserId`.
 *
 * Without the BITE cases this file would pass just as happily against the broken payload.
 */
describe("chat huddle — the participant predicates against the real payload", () => {
  interface FlatParticipant {
    userId?: string | null;
    user?: { id: string; name: string | null } | null;
  }

  const tileName = (participant: FlatParticipant | undefined) => participant?.user?.name ?? "Unknown";
  const nameFor = (participants: FlatParticipant[], userId: string) =>
    tileName(participants.find((p) => p.userId === userId));
  const isInHuddle = (participants: FlatParticipant[], me: string) => participants.some((p) => p.userId === me);
  /** Both shapes, so the predicate can be pointed at the served payload AND at the pre-fix one. */
  interface HuddleHostView {
    startedBy?: string | null;
    startedByMembership?: { user: { id: string; name: string | null } } | null;
  }

  const isHost = (huddle: HuddleHostView, me: string) => huddle.startedBy === me;

  const preFixParticipants = [
    nestedParticipantRow(ME, 1),
    nestedParticipantRow(OTHER, 2),
  ] as unknown as FlatParticipant[];

  it("BITE: the pre-fix nested payload renders every huddle tile as Unknown", () => {
    expect(preFixParticipants.map(tileName)).toEqual(["Unknown", "Unknown"]);
  });

  it("BITE: the pre-fix nested payload never resolves a participant by user id", () => {
    expect(nameFor(preFixParticipants, OTHER)).toBe("Unknown");
  });

  it("BITE: the pre-fix nested payload makes isInHuddle permanently false, so the panel never renders", () => {
    expect(isInHuddle(preFixParticipants, ME)).toBe(false);
  });

  it("BITE: the pre-fix huddle row carries a membership id where the client compares a user id", () => {
    const preFixHuddle = { ...staleCheckRow, startedByMembership: { user: { id: OTHER, name: "Ada Lovelace" } } };
    expect(isHost(preFixHuddle, OTHER)).toBe(false);
    expect(preFixHuddle.startedByMembershipId).toBe(HOST_MEMBERSHIP);
  });

  it("the served payload renders each tile with the participant's real name", async () => {
    const db = makeDb(nestedHuddleRow([nestedParticipantRow(ME, 1), nestedParticipantRow(OTHER, 2)]));
    const huddle = await build(db).getActiveHuddle(CHANNEL, ME, ORG);

    expect(huddle?.participants.map(tileName)).toEqual(["Me", "Ada Lovelace"]);
  });

  it("the served payload resolves a participant by user id", async () => {
    const db = makeDb(nestedHuddleRow([nestedParticipantRow(ME, 1), nestedParticipantRow(OTHER, 2)]));
    const huddle = await build(db).getActiveHuddle(CHANNEL, ME, ORG);

    expect(nameFor(huddle?.participants ?? [], OTHER)).toBe("Ada Lovelace");
  });

  it("the served payload resolves isInHuddle and isHost against the caller's user id", async () => {
    const db = makeDb(nestedHuddleRow([nestedParticipantRow(ME, 1), nestedParticipantRow(OTHER, 2)]));
    const huddle = await build(db).getActiveHuddle(CHANNEL, ME, ORG);

    expect(isInHuddle(huddle?.participants ?? [], ME)).toBe(true);
    expect(isHost(huddle ?? {}, OTHER)).toBe(true);
    expect(isHost(huddle ?? {}, ME)).toBe(false);
  });
});
