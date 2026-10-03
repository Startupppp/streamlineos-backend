import { Test, type TestingModule } from "@nestjs/testing";
import { sql } from "drizzle-orm";
import { BuildEntityActions } from "./build-entity.actions";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import {
  BuildTicketCreationService,
  ProjectsTicketsUpdateService,
  resolveValidTicketStatuses,
} from "../core/tickets";
import type { EntityActor, EntityReference } from "../../entity-reference/entity-reference.types";

jest.mock("../core/tickets");

const mockResolveStatuses = jest.mocked(resolveValidTicketStatuses);

const OWNER: EntityActor = { orgId: "org_1", userId: "user_1", isOrgOwner: true };
const TICKET_REF: EntityReference = { type: "ticket", id: "42" };
const PROJECT_ID = 7;
const TICKET_ID = 42;

const STUB_TICKET = {
  id: TICKET_ID,
  status: "TODO",
  assigneeMembershipId: null as number | null,
  dueDate: null as string | null,
  projectId: PROJECT_ID,
  version: 3,
};

const ticketChange = { updateTicket: jest.fn().mockResolvedValue(undefined) };

function writableProjectSelect(): jest.Mock {
  const limit = jest.fn().mockResolvedValue([{ state: "ACTIVE", reachable: true }]);
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  return jest.fn().mockReturnValue({ from });
}

const REACH = sql`true`;

async function buildService(
  db: object,
): Promise<BuildEntityActions> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      BuildEntityActions,
      { provide: DRIZZLE, useValue: db },
      { provide: AuditService, useValue: { log: jest.fn() } },
      {
        provide: CacheService,
        useValue: {
          invalidateNamespace: jest.fn().mockResolvedValue(undefined),
          del: jest.fn().mockResolvedValue(undefined),
        },
      },
      {
        provide: BuildTicketCreationService,
        useValue: {
          createInTransaction: jest.fn(),
          publish: jest.fn(),
        },
      },
      { provide: ProjectsTicketsUpdateService, useValue: ticketChange },
    ],
  }).compile();
  return module.get(BuildEntityActions);
}

describe("BuildEntityActions — project_id set on activity log insert (ticket 16 writer coverage)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("changeStatus routes the status change to the ticket's own project_id through the canonical update path that writes the project-filterable activity row", async () => {
    mockResolveStatuses.mockResolvedValue(new Set(["TODO", "IN_PROGRESS"]));
    const db = {
      query: {
        tickets: { findFirst: jest.fn().mockResolvedValue(STUB_TICKET) },
        projectMembers: { findFirst: jest.fn() },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 99 }) },
        projects: { findFirst: jest.fn() },
      },
      select: writableProjectSelect(),
    };

    const service = await buildService(db);
    const result = await service.run(OWNER, TICKET_REF, "status", { status: "IN_PROGRESS" }, REACH);

    expect(result.ok).toBe(true);
    expect(ticketChange.updateTicket).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_1", userId: "user_1" }),
      PROJECT_ID,
      TICKET_ID,
      { status: "IN_PROGRESS", version: 3 },
    );
  });

  it("assign routes the assignee change to the ticket's own project_id through the canonical update path that writes the project-filterable activity row", async () => {
    const db = {
      query: {
        tickets: { findFirst: jest.fn().mockResolvedValue(STUB_TICKET) },
        projectMembers: { findFirst: jest.fn().mockResolvedValue({ projectId: PROJECT_ID }) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 55 }) },
        projects: { findFirst: jest.fn() },
      },
      select: writableProjectSelect(),
    };

    const service = await buildService(db);
    const result = await service.run(OWNER, TICKET_REF, "assign", { assigneeId: "user_2" }, REACH);

    expect(result.ok).toBe(true);
    expect(ticketChange.updateTicket).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_1", userId: "user_1" }),
      PROJECT_ID,
      TICKET_ID,
      { assigneeId: "user_2", version: 3 },
    );
  });

  it("setDueDate routes the due-date change to the ticket's own project_id through the canonical update path that writes the project-filterable activity row", async () => {
    const db = {
      query: {
        tickets: { findFirst: jest.fn().mockResolvedValue(STUB_TICKET) },
        projectMembers: { findFirst: jest.fn() },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 99 }) },
        projects: { findFirst: jest.fn() },
      },
      select: writableProjectSelect(),
    };

    const service = await buildService(db);
    const result = await service.run(OWNER, TICKET_REF, "due-date", { dueDate: "2027-01-01" }, REACH);

    expect(result.ok).toBe(true);
    expect(ticketChange.updateTicket).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_1", userId: "user_1" }),
      PROJECT_ID,
      TICKET_ID,
      { dueDate: "2027-01-01", version: 3 },
    );
  });
});
