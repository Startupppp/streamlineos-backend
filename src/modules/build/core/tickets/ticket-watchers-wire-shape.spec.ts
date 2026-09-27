import { ProjectsTicketSubresourcesService } from "./projects-ticket-subresources.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { Db } from "../../../../db/drizzle.module";
import { assertTicketReadAccess } from "./build-ticket-read-access";

jest.mock("./build-ticket-read-access", () => ({
  assertTicketReadAccess: jest.fn(),
}));

/**
 * The build ticket watcher payload, asserted on what the read path RETURNS.
 *
 * `hooks/api/build/watchers.ts:21` reads through `apiClient.get<TicketWatcher[]>`, a cast. The
 * `user` relation on `ticket_watchers` points at `organization_members`, not at a person, so the
 * service shipped the membership row where `TicketWatcher.user` declares a `TicketUser`, and the
 * row carries `membershipId` where the client reads `userId`. A typecheck of either repo passed.
 */

const ORG = "org-1";
const TICKET = 7;
const ME = "user-me";
const OTHER = "user-other";

const actor: CurrentUserContext = {
  userId: ME,
  orgId: ORG,
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

beforeEach(() => {
  jest.mocked(assertTicketReadAccess).mockResolvedValue();
});

/** A watcher row exactly as `with: { user: { with: { user } } }` hands it back. */
function nestedWatcherRow(userId: string | null, id: number) {
  return {
    id,
    ticketId: TICKET,
    createdAt: new Date("2026-09-01T10:00:00Z"),
    user:
      userId === null
        ? null
        : {
            userId,
            user: {
              id: userId,
              name: userId === ME ? "Me" : "Ada Lovelace",
              firstName: null,
              lastName: null,
              image: null,
              email: `${userId}@example.test`,
            },
          },
  };
}

function makeDb(rows: unknown[]) {
  return {
    query: {
      tickets: { findFirst: jest.fn().mockResolvedValue({ id: TICKET }) },
      ticketWatchers: { findMany: jest.fn().mockResolvedValue(rows) },
    },
  } as unknown as Db;
}

function build(db: Db) {
  return new ProjectsTicketSubresourcesService(
    db,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      scopeFor: jest.fn().mockResolvedValue("all"),
      resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
    },
  );
}

describe("build ticket watchers — the person, not the membership row", () => {
  it("GET /build/:p/tickets/:t/watchers puts userId and the user on the watcher", async () => {
    const watchers = await build(makeDb([nestedWatcherRow(ME, 1)])).getWatchers(actor, 1, TICKET);

    expect(watchers).toHaveLength(1);
    expect(watchers[0]?.userId).toBe(ME);
    expect(watchers[0]?.user?.name).toBe("Me");
    expect(watchers[0]?.user).not.toHaveProperty("userId");
    expect(Object.keys(watchers[0] ?? {}).sort()).toEqual(["createdAt", "id", "ticketId", "user", "userId"]);
  });

  it("a watcher whose organization row is gone flattens to nulls, never to a missing key", async () => {
    const watchers = await build(makeDb([nestedWatcherRow(null, 3)])).getWatchers(actor, 1, TICKET);

    expect(watchers[0]?.userId).toBeNull();
    expect(watchers[0]?.user).toBeNull();
    expect(watchers[0] && "user" in watchers[0]).toBe(true);
  });
});

/**
 * The consumer predicates, run against the real payload.
 *
 * `watcher-list.tsx:36` decides `isWatching` by `w.userId === currentUserId`, and `useToggleWatch`
 * branches on it — false means the click always POSTs, so un-watching was unreachable. `:106`
 * names each avatar with `getUserDisplayName(w.user)` and keys it by `w.userId`.
 */
describe("build ticket watchers — the consumer predicates against the real payload", () => {
  interface FlatWatcher {
    userId?: string | null;
    user?: { name?: string | null; firstName?: string | null; lastName?: string | null; email?: string | null } | null;
  }

  const isWatching = (watchers: FlatWatcher[], me: string) => watchers.some((w) => w.userId === me);
  const displayName = (watcher: FlatWatcher | undefined) => {
    const user = watcher?.user;
    if (!user) return "Unassigned";
    if (user.name?.trim()) return user.name.trim();
    const full = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
    if (full) return full;
    return user.email?.trim() ? user.email.split("@")[0] : "Unknown";
  };

  const preFix = [nestedWatcherRow(ME, 1), nestedWatcherRow(OTHER, 2)] as unknown as FlatWatcher[];

  it("BITE: the pre-fix payload leaves isWatching false for a watcher who IS watching", () => {
    expect(isWatching(preFix, ME)).toBe(false);
  });

  it("BITE: the pre-fix payload names every avatar Unknown, because user was the membership row", () => {
    expect(preFix.map(displayName)).toEqual(["Unknown", "Unknown"]);
  });

  it("the served payload answers isWatching and names each avatar", async () => {
    const watchers = await build(makeDb([nestedWatcherRow(ME, 1), nestedWatcherRow(OTHER, 2)])).getWatchers(actor, 1, TICKET);

    expect(isWatching(watchers, ME)).toBe(true);
    expect(isWatching(watchers, "user-nobody")).toBe(false);
    expect(watchers.map(displayName)).toEqual(["Me", "Ada Lovelace"]);
  });
});
