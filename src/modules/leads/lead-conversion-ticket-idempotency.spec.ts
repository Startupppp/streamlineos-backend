import type { Db } from "../../db/drizzle.module";
import { LeadConversionService } from "./lead-conversion.service";

const LEAD = {
  id: 5,
  orgId: "org-a",
  name: "Acme Corp",
  email: "acme@example.com",
  phone: "+1234567890",
  company: "Acme",
  designation: "CEO",
  city: "Mumbai",
  potentialValue: "500000",
  assignedToId: "user-sales",
  status: "converted",
  source: "web",
  priority: "high",
};

const PROJECT = { id: 10, orgId: "org-a" };
const TICKET_TITLE = `Onboard converted lead: ${LEAD.name}`;

function makeDispatch() {
  return { emit: jest.fn().mockResolvedValue(undefined) };
}

function makeAccess() {
  return { membersWithPermission: jest.fn().mockResolvedValue([{ userId: "u1" }]) };
}

function makeMerges() {
  return { merge: jest.fn() };
}

function makeDb(existingTicket: boolean): { db: Db; txInsert: jest.Mock } {
  const txInsert = jest.fn().mockReturnValue({
    values: jest.fn().mockResolvedValue(undefined),
  });

  const db = {
    query: {
      projects: {
        findFirst: jest.fn().mockResolvedValue(PROJECT),
      },
      tickets: {
        findFirst: jest.fn().mockResolvedValue(existingTicket ? { id: 99 } : null),
      },
      clientAccounts: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    select: jest.fn().mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        from: self,
        where: self,
        groupBy: self,
        limit: () => Promise.resolve([]),
        then: (resolve: (v: unknown[]) => unknown) => resolve([]),
      });
      return chain;
    }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: txInsert,
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue([]),
        }),
        execute: jest.fn().mockResolvedValue([{ start: 42 }]),
      }),
    ),
  } as unknown as Db;

  return { db, txInsert };
}

function getDispatchAs(svc: LeadConversionService) {
  return (svc as unknown as Record<string, (...args: unknown[]) => Promise<void>>)
    .dispatchConversionSideEffects;
}

describe("LeadConversionService — onboarding ticket idempotency (retry safety)", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("run-once: creates the onboarding ticket inside a transaction when none exists", async () => {
    const { db, txInsert } = makeDb(false);
    const svc = new LeadConversionService(db, makeAccess() as never, makeDispatch() as never, makeMerges() as never);

    await getDispatchAs(svc).call(svc, "org-a", "user-1", LEAD, null);

    expect((db.transaction as jest.Mock).mock.calls).toHaveLength(1);
    const valuesArg = (txInsert.mock.results[0]?.value as { values: jest.Mock } | undefined)?.values.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(valuesArg?.title).toBe(TICKET_TITLE);
    expect(valuesArg?.ticketNumber).toBe(42);
  });

  it("run-twice: skips ticket creation when a matching ticket already exists (idempotency)", async () => {
    const { db } = makeDb(true);
    const svc = new LeadConversionService(db, makeAccess() as never, makeDispatch() as never, makeMerges() as never);

    await getDispatchAs(svc).call(svc, "org-a", "user-1", LEAD, null);
    await getDispatchAs(svc).call(svc, "org-a", "user-1", LEAD, null);

    expect((db.transaction as jest.Mock).mock.calls).toHaveLength(0);
  });

  it("run-twice with fresh state: transaction called exactly once (first call creates, second finds existing)", async () => {
    let existingTicket = false;
    const txInsert = jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) });

    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(PROJECT) },
        tickets: {
          findFirst: jest.fn().mockImplementation(() =>
            Promise.resolve(existingTicket ? { id: 99 } : null),
          ),
        },
        clientAccounts: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockImplementation(() => {
        const chain: Record<string, unknown> = {};
        const self = () => chain;
        Object.assign(chain, {
          from: self, where: self, groupBy: self,
          limit: () => Promise.resolve([]),
          then: (resolve: (v: unknown[]) => unknown) => resolve([]),
        });
        return chain;
      }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        existingTicket = true;
        return fn({
          insert: txInsert,
          select: jest.fn().mockReturnValue({
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue([]),
          }),
          execute: jest.fn().mockResolvedValue([{ start: 42 }]),
        });
      }),
    } as unknown as Db;

    const svc = new LeadConversionService(db, makeAccess() as never, makeDispatch() as never, makeMerges() as never);

    await getDispatchAs(svc).call(svc, "org-a", "user-1", LEAD, null);
    await getDispatchAs(svc).call(svc, "org-a", "user-1", LEAD, null);

    expect((db.transaction as jest.Mock).mock.calls).toHaveLength(1);
  });
});
