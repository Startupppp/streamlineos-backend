import { SupportWorkspaceService } from "./support-workspace.service";
import type { Db } from "../../../db/drizzle.module";

/**
 * The watcher payload, asserted on what the read path RETURNS — not on what a caller declares.
 *
 * `hooks/api/support/watchers.ts:21` reads through `apiClient.get<SupportTicketWatcher[]>`, a cast.
 * That interface has always declared `userId` and `user` at the top level; the service shipped the
 * `organization_members` join verbatim as `membership: { id, userId }`, with no `user` selected at
 * all. Both repos typechecked with the two shapes in open disagreement, so nothing here relies on a
 * typecheck.
 */

const ORG = "org-1";
const TICKET = 7;
const ME = "user-me";
const OTHER = "user-other";

/** A watcher row exactly as `with: { membership: { with: { user } } }` hands it back. */
function nestedWatcherRow(userId: string | null, id: number) {
  return {
    id,
    orgId: ORG,
    ticketId: TICKET,
    createdAt: new Date("2026-09-01T10:00:00Z"),
    membership:
      userId === null
        ? null
        : { userId, user: { id: userId, name: userId === ME ? "Me" : "Ada Lovelace", image: null } },
  };
}

function makeDb(rows: unknown[]) {
  return {
    query: {
      supportTickets: { findFirst: jest.fn().mockResolvedValue({ id: TICKET }) },
      supportTicketWatchers: { findMany: jest.fn().mockResolvedValue(rows) },
    },
  } as unknown as Db;
}

describe("support ticket watchers — the identity is at the top level", () => {
  it("GET /support/:id/watchers puts userId and user on the watcher, not under membership", async () => {
    const db = makeDb([nestedWatcherRow(ME, 1)]);
    const watchers = await new SupportWorkspaceService(db).listWatchers(ORG, TICKET);

    expect(watchers).toHaveLength(1);
    expect(watchers[0]).not.toHaveProperty("membership");
    expect(watchers[0]?.userId).toBe(ME);
    expect(watchers[0]?.user).toEqual({ id: ME, name: "Me", image: null });
  });

  it("keeps the internal join key off the wire", async () => {
    const db = makeDb([nestedWatcherRow(ME, 1)]);
    const watchers = await new SupportWorkspaceService(db).listWatchers(ORG, TICKET);

    expect(watchers[0]).not.toHaveProperty("userMembershipId");
    expect(Object.keys(watchers[0] ?? {}).sort()).toEqual([
      "createdAt",
      "id",
      "orgId",
      "ticketId",
      "user",
      "userId",
    ]);
  });

  it("selects the user columns — the pre-fix query asked for none of them", async () => {
    const db = makeDb([nestedWatcherRow(ME, 1)]);
    await new SupportWorkspaceService(db).listWatchers(ORG, TICKET);

    const [call] = (db.query.supportTicketWatchers.findMany as unknown as jest.Mock).mock.calls;
    expect(call?.[0]?.with?.membership?.with?.user?.columns).toEqual({
      id: true,
      name: true,
      image: true,
    });
  });

  it("a watcher whose organization row is gone flattens to nulls, never to a missing key", async () => {
    const db = makeDb([nestedWatcherRow(null, 3)]);
    const watchers = await new SupportWorkspaceService(db).listWatchers(ORG, TICKET);

    expect(watchers[0]?.userId).toBeNull();
    expect(watchers[0]?.user).toBeNull();
    expect(watchers[0] && "userId" in watchers[0]).toBe(true);
  });
});

/**
 * The consumer predicate, run against the real payload.
 *
 * `ticket-detail-header.tsx:65` decides `isFollowing` by `w.userId === currentUserId`, and
 * `handleToggleFollow` at `:101` branches on it: false means the click always takes the FOLLOW
 * branch, so `DELETE /support/:id/follow` was unreachable from the UI and a user who followed a
 * ticket could never stop.
 */
describe("support ticket watchers — the follow predicate against the real payload", () => {
  interface FlatWatcher {
    userId?: string | null;
  }

  const isFollowing = (watchers: FlatWatcher[], me: string) => watchers.some((w) => w.userId === me);

  it("BITE: the pre-fix nested payload leaves isFollowing false for a watcher who IS following", () => {
    const preFix = [nestedWatcherRow(ME, 1)] as unknown as FlatWatcher[];
    expect(isFollowing(preFix, ME)).toBe(false);
  });

  it("the served payload answers isFollowing against the caller's own user id", async () => {
    const db = makeDb([nestedWatcherRow(ME, 1), nestedWatcherRow(OTHER, 2)]);
    const watchers = await new SupportWorkspaceService(db).listWatchers(ORG, TICKET);

    expect(isFollowing(watchers, ME)).toBe(true);
    expect(isFollowing(watchers, "user-nobody")).toBe(false);
  });
});
