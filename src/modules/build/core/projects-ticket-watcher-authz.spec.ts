import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ProjectsTicketSubresourcesService } from "./projects-ticket-subresources.service";

const CALLER_ORG = "org-a";
const CALLER_ID = "user-caller";
const OTHER_MEMBER_ID = "user-teammate";

const dialect = new PgDialect();

function makeUser(orgId = CALLER_ORG, userId = CALLER_ID): CurrentUserContext {
  return {
    orgId,
    userId,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: null as never,
  };
}

function makeDb(opts: { ticket: object | null; member: { id: number } | null }): {
  db: Db;
  lookups: SQL[];
} {
  const lookups: SQL[] = [];
  const selectChain = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(opts.member ? [opts.member] : []),
  };
  selectChain.from.mockReturnValue(selectChain);
  selectChain.where.mockImplementation((predicate: SQL) => {
    lookups.push(predicate);
    return selectChain;
  });

  const valuesChain = { onConflictDoNothing: jest.fn().mockResolvedValue(undefined) };
  const insertChain = { values: jest.fn().mockReturnValue(valuesChain) };

  const db = {
    query: {
      tickets: { findFirst: jest.fn().mockResolvedValue(opts.ticket) },
      ticketWatchers: { findMany: jest.fn().mockResolvedValue([]) },
    },
    select: jest.fn().mockReturnValue(selectChain),
    insert: jest.fn().mockReturnValue(insertChain),
  } as unknown as Db;

  return { db, lookups };
}

function makeSvc(db: Db) {
  return new ProjectsTicketSubresourcesService(
    db,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

function boundParams(lookups: SQL[]): unknown[] {
  return lookups.flatMap((predicate) => dialect.sqlToQuery(predicate).params);
}

describe("ProjectsTicketSubresourcesService — addWatcher", () => {
  it("watches the caller when the body omits userId, so self-watch needs no id from the client", async () => {
    const { db, lookups } = makeDb({ ticket: { id: 1 }, member: { id: 42 } });

    const result = await makeSvc(db).addWatcher(makeUser(), 1, {});

    expect(result).toEqual({ success: true });
    expect(boundParams(lookups)).toContain(CALLER_ID);
  });

  it("watches the named teammate when the body carries their userId", async () => {
    const { db, lookups } = makeDb({ ticket: { id: 1 }, member: { id: 43 } });

    const result = await makeSvc(db).addWatcher(makeUser(), 1, { userId: OTHER_MEMBER_ID });

    expect(result).toEqual({ success: true });
    const params = boundParams(lookups);
    expect(params).toContain(OTHER_MEMBER_ID);
    expect(params).not.toContain(CALLER_ID);
  });

  it("resolves the watcher inside the caller's org, so a foreign id cannot be attached", async () => {
    const { db, lookups } = makeDb({ ticket: { id: 1 }, member: { id: 43 } });

    await makeSvc(db).addWatcher(makeUser(), 1, { userId: OTHER_MEMBER_ID });

    expect(boundParams(lookups)).toContain(CALLER_ORG);
  });

  it("returns 404 rather than 403 for a ticket in another organisation", async () => {
    const { db } = makeDb({ ticket: null, member: { id: 42 } });

    await expect(makeSvc(db).addWatcher(makeUser("org-attacker"), 99, {})).rejects.toThrow(
      NotFoundException,
    );
  });

  it("rejects a watcher who is not an active member of the organisation", async () => {
    const { db } = makeDb({ ticket: { id: 1 }, member: null });

    await expect(
      makeSvc(db).addWatcher(makeUser(), 1, { userId: OTHER_MEMBER_ID }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("ProjectsTicketSubresourcesService — addWatcher bite proof", () => {
  it("the ticket lookup is load-bearing: it alone separates a foreign ticket from a watchable one", async () => {
    const withTicket = makeDb({ ticket: { id: 99 }, member: { id: 42 } });
    await expect(
      makeSvc(withTicket.db).addWatcher(makeUser("org-attacker"), 99, {}),
    ).resolves.toEqual({ success: true });

    const withoutTicket = makeDb({ ticket: null, member: { id: 42 } });
    await expect(
      makeSvc(withoutTicket.db).addWatcher(makeUser("org-attacker"), 99, {}),
    ).rejects.toThrow(NotFoundException);
  });
});
