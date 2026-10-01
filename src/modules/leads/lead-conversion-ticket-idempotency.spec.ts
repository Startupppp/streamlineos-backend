import type { Db } from "../../db/drizzle.module";
import { LeadConversionService } from "./lead-conversion.service";
import type { BuildTicketCreationService } from "../build/core/tickets";

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

function makeTicketCreation(): BuildTicketCreationService & { create: jest.Mock } {
  return {
    create: jest.fn().mockResolvedValue({ tickets: [{ id: 88 }] }),
    createInTransaction: jest.fn().mockResolvedValue({ tickets: [{ id: 88 }] }),
    publish: jest.fn(),
  } as unknown as BuildTicketCreationService & { create: jest.Mock };
}

function makeDb(existingTicket: boolean): Db {
  return {
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
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue([]),
        }),
        execute: jest.fn().mockResolvedValue([{ start: 42 }]),
      }),
    ),
  } as unknown as Db;
}

function getDispatchAs(svc: LeadConversionService) {
  return (svc as unknown as Record<string, (...args: unknown[]) => Promise<void>>)
    .dispatchConversionSideEffects;
}

describe("LeadConversionService — onboarding ticket idempotency (retry safety)", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("run-once: creates the onboarding ticket via ticketCreation.create when none exists", async () => {
    const db = makeDb(false);
    const ticketCreation = makeTicketCreation();
    const svc = new LeadConversionService(db, makeAccess() as never, makeDispatch() as never, makeMerges() as never, ticketCreation);

    await getDispatchAs(svc).call(svc, "org-a", "user-1", LEAD, null);

    expect(ticketCreation.create).toHaveBeenCalledTimes(1);
    const callArg = ticketCreation.create.mock.calls[0]?.[0] as { drafts: Array<{ title: string }> } | undefined;
    expect(callArg?.drafts[0]?.title).toBe(TICKET_TITLE);
  });

  it("run-twice: skips ticket creation when a matching ticket already exists (idempotency)", async () => {
    const db = makeDb(true);
    const ticketCreation = makeTicketCreation();
    const svc = new LeadConversionService(db, makeAccess() as never, makeDispatch() as never, makeMerges() as never, ticketCreation);

    await getDispatchAs(svc).call(svc, "org-a", "user-1", LEAD, null);
    await getDispatchAs(svc).call(svc, "org-a", "user-1", LEAD, null);

    expect(ticketCreation.create).not.toHaveBeenCalled();
  });

  it("run-twice with fresh state: ticketCreation.create called exactly once (first call creates, second finds existing)", async () => {
    let created = false;
    const ticketCreation = makeTicketCreation();
    (ticketCreation.create as jest.Mock).mockImplementation(async () => {
      created = true;
      return { tickets: [{ id: 88 }] };
    });

    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(PROJECT) },
        tickets: {
          findFirst: jest.fn().mockImplementation(() =>
            Promise.resolve(created ? { id: 99 } : null),
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
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
          select: jest.fn().mockReturnValue({
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue([]),
          }),
          execute: jest.fn().mockResolvedValue([{ start: 42 }]),
        }),
      ),
    } as unknown as Db;

    const svc = new LeadConversionService(db, makeAccess() as never, makeDispatch() as never, makeMerges() as never, ticketCreation);

    await getDispatchAs(svc).call(svc, "org-a", "user-1", LEAD, null);
    await getDispatchAs(svc).call(svc, "org-a", "user-1", LEAD, null);

    expect(ticketCreation.create).toHaveBeenCalledTimes(1);
  });
});
