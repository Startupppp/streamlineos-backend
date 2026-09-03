import { NotFoundException } from "@nestjs/common";
import { SupportTicketsService } from "./support-tickets.service";
import type { Db } from "../../../db/drizzle.module";

/**
 * The ticket list and detail must not ship the whole `organization_members` row.
 *
 * A Drizzle relational read with no `columns:` selects EVERY column of the joined
 * table, and `assigneeMembership` / `creatorMembership` had none. So each ticket
 * carried all eleven columns of its assignee's and its creator's membership row —
 * on every ticket, of every page, of every list response, to anyone holding
 * `support:tickets:view`.
 *
 * The over-exposed columns are not tokens or salary; they are employment state
 * and authorization posture: `status` (`SUSPENDED` / `LEFT`), `suspendedAt`,
 * `leftAt`, `invitedAt`, `activatedAt`, `joinedAt`, `role`, `isOwner`. That a
 * colleague was suspended, and when, is HR information; `role` and `isOwner` hand
 * an org privilege map to every ticket viewer. None of it is read: the service
 * uses `assigneeMembership.user.id` and nothing else, and no component in the
 * ticket UI reads the membership at all.
 *
 * Asserted on the QUERY the service issues, not on a row a double hands back — a
 * projection is decided by the request, so only the request can prove it. The
 * `columns: { id: true }` is the assertion: it must be present (an absent
 * `columns` selects everything) and it must not be `{}` (which selects nothing
 * and would emit an empty object, the shape that cost the huddle its `userId`).
 */

const ORG = "org-1";
const MEMBERSHIP_WITH_KEYS = ["assigneeMembership", "creatorMembership"] as const;

/** `snoozed` is required-but-undefined on ListTicketsQuery; ts-jest would not have said so. */
const LIST_QUERY = {
  page: 1,
  limit: 20,
  snoozed: undefined,
  scope: "all" as const,
  userId: "user-me",
};

interface RelationOptions {
  columns?: Record<string, boolean>;
  with?: Record<string, RelationOptions>;
}

function isRelationOptions(value: unknown): value is RelationOptions {
  return typeof value === "object" && value !== null;
}

function makeDb(capture: (options: RelationOptions) => void) {
  const findMany = jest.fn((options: RelationOptions) => {
    capture(options);
    return Promise.resolve([]);
  });
  const findFirst = jest.fn((options: RelationOptions) => {
    capture(options);
    return Promise.resolve(undefined);
  });
  return {
    query: { supportTickets: { findMany, findFirst } },
    select: () => ({ from: () => ({ where: () => Promise.resolve([{ count: 0 }]) }) }),
  } as unknown as Db;
}

/** `listTickets` reads only `cache` and `db`; `getTicket` only `db`. */
function makeService(db: Db): SupportTicketsService {
  const cache = {
    cachedVersioned: (_ns: string, _key: string, load: () => Promise<unknown>) => load(),
  };
  const unused = {} as unknown as never;
  return new SupportTicketsService(
    db,
    cache as unknown as never,
    unused, unused, unused, unused, unused, unused, unused, unused, unused, unused, unused,
  );
}

function assertRestricted(options: RelationOptions) {
  const relations = options.with;
  expect(relations).toBeDefined();
  for (const key of MEMBERSHIP_WITH_KEYS) {
    const relation = relations?.[key];
    if (!isRelationOptions(relation)) continue;
    expect(relation.columns).toBeDefined();
    expect(Object.keys(relation.columns ?? {})).toEqual(["id"]);
  }
}

describe("support tickets do not ship the whole organization_members row", () => {
  it("restricts the membership projection on the ticket LIST", async () => {
    const seen: RelationOptions[] = [];
    const service = makeService(makeDb((o) => seen.push(o)));

    await service.listTickets(ORG, LIST_QUERY);

    expect(seen).toHaveLength(1);
    const options = seen[0];
    expect(options).toBeDefined();
    if (options === undefined) return;
    assertRestricted(options);
    expect(options.with?.["assigneeMembership"]).toBeDefined();
    expect(options.with?.["creatorMembership"]).toBeDefined();
  });

  it("restricts the membership projection on the ticket DETAIL", async () => {
    const seen: RelationOptions[] = [];
    const service = makeService(makeDb((o) => seen.push(o)));

    await expect(
      service.getTicket(ORG, 7, { userId: "user-me", scope: "all" }),
    ).rejects.toThrow(NotFoundException);

    expect(seen).toHaveLength(1);
    const options = seen[0];
    expect(options).toBeDefined();
    if (options === undefined) return;
    assertRestricted(options);
  });

  it("never restricts it to columns: {} , which selects nothing and emits {}", async () => {
    const seen: RelationOptions[] = [];
    const service = makeService(makeDb((o) => seen.push(o)));

    await service.listTickets(ORG, LIST_QUERY);

    for (const key of MEMBERSHIP_WITH_KEYS) {
      const relation = seen[0]?.with?.[key];
      if (!isRelationOptions(relation)) continue;
      expect(Object.keys(relation.columns ?? {}).length).toBeGreaterThan(0);
    }
  });
});
