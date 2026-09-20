import { BadRequestException } from "@nestjs/common";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { AccessService } from "../../access/access.service";
import type { Db } from "../../../db/drizzle.types";
import { bulkMutateTickets } from "./build-ticket-bulk-mutation";

const actor: CurrentUserContext = {
  orgId: "11111111-1111-4111-8111-111111111111",
  userId: "owner",
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "session",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

function makeDb(ids: number[]) {
  const rows = ids.map((id) => ({
    id,
    status: "TODO",
    rank: "1000",
    version: 1,
    assigneeMembershipId: null,
    dueDate: null,
    priority: "MEDIUM",
    points: 1,
    epicId: null,
    sprintId: null,
    allowed: true,
  }));
  const chain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    for: jest.fn().mockReturnThis(),
    then: (resolve: (value: typeof rows) => unknown) => Promise.resolve(rows).then(resolve),
  };
  const db = {
    select: jest.fn(() => chain),
    update: jest.fn(() => ({
      set: jest.fn(() => ({ where: jest.fn(() => ({ returning: jest.fn().mockResolvedValue(rows) })) })),
    })),
    execute: jest.fn().mockResolvedValue([]),
    query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, managerMembershipId: 1 }) } },
    transaction: jest.fn(),
  };
  db.transaction.mockImplementation(async (callback: (tx: typeof db) => Promise<unknown>) => callback(db));
  return db;
}

const access = { scopeFor: jest.fn().mockResolvedValue("all") } as unknown as AccessService;

/**
 * `readMutationTickets` reads `inArray(tickets.id, ids)` FOR UPDATE with no LIMIT, which is
 * why `check:unbounded-reads` matches it. The read is safe only because every caller bounds
 * `ids` first, so these are the assertions that classification rests on. If the 100-cap is
 * ever widened or moved below the read, this file fails rather than the gate quietly
 * suppressing a now-unbounded row lock.
 */
describe("build ticket mutation reads are bounded by their caller", () => {
  it("refuses more than 100 ids before opening a transaction or issuing the read", async () => {
    const db = makeDb([]);
    const ticketIds = Array.from({ length: 101 }, (_, index) => index + 1);

    await expect(
      bulkMutateTickets(db as unknown as Db, access, actor, 1, { ticketIds }),
    ).rejects.toThrow(BadRequestException);

    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("reads the maximum batch in exactly one statement", async () => {
    const ticketIds = Array.from({ length: 100 }, (_, index) => index + 1);
    const db = makeDb(ticketIds);

    await bulkMutateTickets(db as unknown as Db, access, actor, 1, { ticketIds });

    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("deduplicates before applying the cap, so repeats cannot smuggle the batch past 100", async () => {
    const unique = Array.from({ length: 100 }, (_, index) => index + 1);
    const db = makeDb(unique);

    await bulkMutateTickets(db as unknown as Db, access, actor, 1, { ticketIds: [...unique, ...unique] });

    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("still refuses when the ids are unique and one over the cap", async () => {
    const db = makeDb([]);
    const ticketIds = Array.from({ length: 250 }, (_, index) => index + 1).slice(0, 101);

    await expect(
      bulkMutateTickets(db as unknown as Db, access, actor, 1, { ticketIds }),
    ).rejects.toThrow("Select between 1 and 100 tickets");
  });

  it("refuses an empty selection rather than reading the whole project", async () => {
    const db = makeDb([]);

    await expect(
      bulkMutateTickets(db as unknown as Db, access, actor, 1, { ticketIds: [] }),
    ).rejects.toThrow(BadRequestException);

    expect(db.select).not.toHaveBeenCalled();
  });
});
