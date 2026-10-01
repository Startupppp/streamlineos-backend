jest.mock("../../../../common/organization/organization-actor", () => ({
  resolveOrganizationActorsByUserIds: jest.fn(),
}));
jest.mock("../project-crud/project-access", () => ({
  assertProjectVisible: jest.fn(),
  resolveProjectAssignableMemberships: jest.fn(),
}));
jest.mock("../lib/allocate-ticket-number", () => ({
  allocateTicketNumbers: jest.fn(),
}));
jest.mock("../lib/build-ticket-capacity", () => ({
  reserveTicketCapacity: jest.fn(),
}));

import { ProjectsTicketsCreateService } from "./projects-tickets-create.service";
import { resolveOrganizationActorsByUserIds } from "../../../../common/organization/organization-actor";
import { assertProjectVisible, resolveProjectAssignableMemberships } from "../project-crud/project-access";
import { allocateTicketNumbers } from "../lib/allocate-ticket-number";
import { reserveTicketCapacity } from "../lib/build-ticket-capacity";
import { runWithTenantContext } from "../../../../common/tenant/tenant-context";
import type { TenantTx } from "../../../../db/drizzle.types";
import type { Db } from "../../../../db/drizzle.module";

const ORG = "org-sp-create";
const CREATOR = "user-creator";
const ASSIGNEE = "user-assignee";

const TICKET_ROW = {
  id: 10,
  orgId: ORG,
  projectId: 1,
  ticketNumber: 1,
  title: "T",
  type: "TASK",
  priority: "MEDIUM",
  assigneeMembershipId: 2,
  status: "TODO",
  isRecurring: false,
};

beforeEach(() => {
  jest.resetAllMocks();
  (assertProjectVisible as jest.Mock).mockResolvedValue(undefined);
  (resolveProjectAssignableMemberships as jest.Mock).mockResolvedValue(new Map([[ASSIGNEE, 2]]));
  (resolveOrganizationActorsByUserIds as jest.Mock).mockResolvedValue(
    new Map([[CREATOR, { membershipId: 1, orgId: ORG, userId: CREATOR, role: "MEMBER", isOwner: false, resolvedVia: "user", organizationPersonId: null }]]),
  );
  (allocateTicketNumbers as jest.Mock).mockResolvedValue(1);
  (reserveTicketCapacity as jest.Mock).mockResolvedValue(undefined);
});

function makeDb() {
  const valuesMock = jest.fn().mockReturnValue({
    returning: jest.fn().mockResolvedValue([TICKET_ROW]),
  });
  const insertMock = jest.fn().mockReturnValue({ values: valuesMock });
  const tx = { insert: insertMock, execute: jest.fn().mockResolvedValue([]) };
  const db = {
    transaction: jest.fn().mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([{ key: "TST" }]),
        }),
      }),
    }),
    query: {},
  } as unknown as Db;
  return { db };
}

function makeSvc(db: Db, dispatchEmit = jest.fn().mockResolvedValue(undefined)) {
  return new ProjectsTicketsCreateService(
    db,
    {} as never,
    { emit: dispatchEmit } as never,
    {} as never,
    {} as never,
    { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
    { runForTicketEvent: jest.fn() } as never,
    { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never,
    { holds: jest.fn().mockResolvedValue(true) } as never,
  );
}

const ACTOR = {
  orgId: ORG,
  userId: CREATOR,
  isOrgOwner: false,
  principal: { kind: "human-session", membershipId: 1, isOrgOwner: false },
} as never;

describe("ProjectsTicketsCreateService.createTicket — withSavepoint wraps assignment notification (site 4, ticket 38)", () => {
  it("dispatch.emit for ticket assignment is wrapped in withSavepoint — outerTx.transaction called once when assignee differs from creator", async () => {
    const savepointTx = {} as unknown as TenantTx;
    let txCallCount = 0;
    const outerTransaction = jest.fn().mockImplementation(
      async (fn: (sp: TenantTx) => Promise<unknown>) => {
        txCallCount++;
        return fn(savepointTx);
      },
    );
    const outerTx = { transaction: outerTransaction } as unknown as TenantTx;

    const { db } = makeDb();
    const svc = makeSvc(db);

    await runWithTenantContext(
      { orgId: ORG, audience: "INTERNAL" as const, tx: outerTx },
      () => svc.createTicket(ACTOR, 1, { title: "T", type: "TASK", assigneeId: ASSIGNEE }),
    );

    expect(txCallCount).toBe(1);
  });

  it("positive: dispatch.emit is called with build.ticket.assigned event when assignee differs from creator", async () => {
    const dispatchEmit = jest.fn().mockResolvedValue(undefined);
    const { db } = makeDb();
    const svc = makeSvc(db, dispatchEmit);

    await svc.createTicket(ACTOR, 1, { title: "T", type: "TASK", assigneeId: ASSIGNEE });

    expect(dispatchEmit).toHaveBeenCalledTimes(1);
    const call = dispatchEmit.mock.calls[0]?.[0] as { eventKey?: string; targetUserIds?: string[] };
    expect(call?.eventKey).toBe("build.ticket.assigned");
    expect(call?.targetUserIds).toContain(ASSIGNEE);
  });

  it("positive: no notification dispatched when there are no assignees", async () => {
    const dispatchEmit = jest.fn().mockResolvedValue(undefined);
    const { db } = makeDb();
    const svc = makeSvc(db, dispatchEmit);

    await svc.createTicket(ACTOR, 1, { title: "T", type: "TASK" });

    expect(dispatchEmit).not.toHaveBeenCalled();
  });
});
