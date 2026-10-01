import { LeadConversionService } from "./lead-conversion.service";
import { BuildTicketCreationService } from "../build/core/tickets";
import type { AccessService } from "../access/access.service";
import type { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import type { PartyMergeService } from "../party/party-merge.service";
import type { Db } from "../../db/drizzle.module";

function makeDb(overrides: Partial<{
  findFirstProject: unknown;
  findFirstTicket: unknown;
}> = {}) {
  return {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue(overrides.findFirstProject ?? null) },
      tickets: { findFirst: jest.fn().mockResolvedValue(overrides.findFirstTicket ?? null) },
    },
    transaction: jest.fn(),
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
  } as unknown as Db;
}

function makeTicketCreation() {
  return {
    create: jest.fn().mockResolvedValue({ command: {}, tickets: [{ id: 99 }] }),
    createInTransaction: jest.fn(),
    publish: jest.fn(),
  } as unknown as BuildTicketCreationService;
}

const mockAccess = { membersWithPermission: jest.fn().mockResolvedValue([]) } as unknown as AccessService;
const mockDispatch = { emit: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationDispatchService;
const mockPartyMerge = { mergeParties: jest.fn().mockResolvedValue(undefined) } as unknown as PartyMergeService;

const LEAD = {
  id: 1,
  name: "Acme Corp",
  company: "Acme",
  email: "acme@example.com",
  phone: "555-0100",
  assignedToId: null,
  potentialValue: 50000,
};

beforeEach(() => {
  jest.resetAllMocks();
  mockDispatch.emit = jest.fn().mockResolvedValue(undefined);
  mockAccess.membersWithPermission = jest.fn().mockResolvedValue([]);
});

describe("LeadConversionService — onboarding ticket creation via canonical path", () => {
  it("routes the onboarding ticket through canonical BuildTicketCreationService — does not call db.insert(tickets) directly", async () => {
    const ticketCreation = makeTicketCreation();
    const db = makeDb({
      findFirstProject: { id: 10, orgId: "org-1" },
      findFirstTicket: null,
    });
    const svc = new LeadConversionService(db, mockAccess, mockDispatch, mockPartyMerge, ticketCreation);

    await (svc as unknown as { dispatchConversionSideEffects: (...args: unknown[]) => Promise<void> })
      .dispatchConversionSideEffects("org-1", "user-1", LEAD, null);

    expect((ticketCreation.create as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((ticketCreation.create as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        projectId: 10,
        actor: expect.objectContaining({ userId: "user-1" }),
        drafts: expect.arrayContaining([
          expect.objectContaining({ title: expect.stringContaining("Acme Corp") }),
        ]),
      }),
    );
    expect((db as unknown as { insert: jest.Mock }).insert).not.toHaveBeenCalled();
  });

  it("skips ticket creation when a matching onboard ticket already exists", async () => {
    const ticketCreation = makeTicketCreation();
    const db = makeDb({
      findFirstProject: { id: 10, orgId: "org-1" },
      findFirstTicket: { id: 55 },
    });
    const svc = new LeadConversionService(db, mockAccess, mockDispatch, mockPartyMerge, ticketCreation);

    await (svc as unknown as { dispatchConversionSideEffects: (...args: unknown[]) => Promise<void> })
      .dispatchConversionSideEffects("org-1", "user-1", LEAD, null);

    expect((ticketCreation.create as jest.Mock)).not.toHaveBeenCalled();
    expect((db as unknown as { insert: jest.Mock }).insert).not.toHaveBeenCalled();
  });
});
