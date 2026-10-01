import { Test, type TestingModule } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { BuildEntityActions } from "./build-entity.actions";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { BuildTicketCreationService, resolveValidTicketStatuses } from "../core/tickets";
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
};

function makeTxCapture(): {
  tx: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    execute: jest.Mock;
    insert: jest.Mock;
  };
  getCapturedActivity: () => Record<string, unknown> | undefined;
} {
  let capturedValues: Record<string, unknown> | undefined;

  const tx = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
    execute: jest.fn(async (statement: SQL) => {
      const sqlText = new PgDialect().sqlToQuery(statement).sql;
      if (sqlText.includes("project_ticket_counters")) return [{ start: 1 }];
      return [];
    }),
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation((v: unknown) => {
        capturedValues = v as Record<string, unknown>;
        return Promise.resolve(undefined);
      }),
    })),
  };

  return { tx, getCapturedActivity: () => capturedValues };
}

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
    ],
  }).compile();
  return module.get(BuildEntityActions);
}

describe("BuildEntityActions — project_id set on activity log insert (ticket 16 writer coverage)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("changeStatus passes the ticket's project_id to the activity log insert so the status-change event is filterable by project", async () => {
    mockResolveStatuses.mockResolvedValue(new Set(["TODO", "IN_PROGRESS"]));
    const { tx, getCapturedActivity } = makeTxCapture();

    const db = {
      query: {
        tickets: { findFirst: jest.fn().mockResolvedValue(STUB_TICKET) },
        projectMembers: { findFirst: jest.fn() },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 99 }) },
        projects: { findFirst: jest.fn() },
      },
      transaction: jest.fn().mockImplementation(
        async (cb: (handle: typeof tx) => Promise<unknown>) => cb(tx),
      ),
    };

    const service = await buildService(db);
    const result = await service.run(OWNER, TICKET_REF, "status", { status: "IN_PROGRESS" });

    expect(result.ok).toBe(true);
    expect(getCapturedActivity()?.["projectId"]).toBe(PROJECT_ID);
  });

  it("assign passes the ticket's project_id to the activity log insert so the assignee-change event is filterable by project", async () => {
    const { tx, getCapturedActivity } = makeTxCapture();

    const db = {
      query: {
        tickets: { findFirst: jest.fn().mockResolvedValue(STUB_TICKET) },
        projectMembers: { findFirst: jest.fn().mockResolvedValue({ projectId: PROJECT_ID }) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 55 }) },
        projects: { findFirst: jest.fn() },
      },
      transaction: jest.fn().mockImplementation(
        async (cb: (handle: typeof tx) => Promise<unknown>) => cb(tx),
      ),
    };

    const service = await buildService(db);
    const result = await service.run(OWNER, TICKET_REF, "assign", { assigneeId: "user_2" });

    expect(result.ok).toBe(true);
    expect(getCapturedActivity()?.["projectId"]).toBe(PROJECT_ID);
  });

  it("setDueDate passes the ticket's project_id to the activity log insert so the due-date-change event is filterable by project", async () => {
    const { tx, getCapturedActivity } = makeTxCapture();

    const db = {
      query: {
        tickets: { findFirst: jest.fn().mockResolvedValue(STUB_TICKET) },
        projectMembers: { findFirst: jest.fn() },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 99 }) },
        projects: { findFirst: jest.fn() },
      },
      transaction: jest.fn().mockImplementation(
        async (cb: (handle: typeof tx) => Promise<unknown>) => cb(tx),
      ),
    };

    const service = await buildService(db);
    const result = await service.run(OWNER, TICKET_REF, "due-date", { dueDate: "2027-01-01" });

    expect(result.ok).toBe(true);
    expect(getCapturedActivity()?.["projectId"]).toBe(PROJECT_ID);
  });
});
