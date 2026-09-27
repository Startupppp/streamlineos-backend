import { SQL } from "drizzle-orm";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { systemActor } from "../../../../common/auth/system-actor";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.module";
import { ProjectsTicketsUpdateService } from "./projects-tickets-update.service";

jest.mock("../project-access", () => ({
  ...jest.requireActual("../project-access"),
  resolveProjectAccess: jest.fn().mockResolvedValue({ hasAccess: true, role: "MEMBER" }),
}));

const TICKET_ID = 1;
const PROPOSED_PARENT_ID = 2;
const PROJECT_ID = 1;
const ORG = "org-test";

function extractValueChunks(statement: unknown): string {
  const chunks = statement instanceof SQL ? statement.queryChunks : [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string" || typeof chunk === "number") return String(chunk);
      if (typeof chunk === "object" && chunk !== null && "value" in chunk)
        return String((chunk as { value: unknown }).value);
      return "";
    })
    .join("");
}

function makeDb(capturedExecuteValues: string[]) {
  const chainRow = { id: PROPOSED_PARENT_ID, next_id: null, project_id: PROJECT_ID, depth: 0 };
  const txFn = jest.fn().mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ id: TICKET_ID }]),
            }),
          }),
        }),
        delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
        }),
        execute: jest.fn((statement: unknown) => {
          capturedExecuteValues.push(extractValueChunks(statement));
          return Promise.resolve([chainRow]);
        }),
      }),
  );

  const ticket = {
    id: TICKET_ID,
    orgId: ORG,
    projectId: PROJECT_ID,
    status: "TODO",
    version: 1,
    title: "Ticket",
    priority: "MEDIUM",
    assigneeMembershipId: null,
    assignee: null,
    sprintId: null,
    startDate: null,
    dueDate: null,
    reporterId: "r1",
    updatedAt: new Date("2026-01-01"),
    points: null,
    type: "TASK",
    cycleId: null,
  };

  return {
    query: { tickets: { findFirst: jest.fn().mockResolvedValue(ticket) } },
    transaction: txFn,
  } as unknown as Db;
}

function makeActor(): CurrentUserContext {
  return {
    orgId: ORG,
    userId: "human-user",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(10, false),
  };
}

const dispatch = { emit: jest.fn().mockResolvedValue(undefined) } as never;
const activity = { logTicketFieldChanges: jest.fn().mockResolvedValue(undefined) } as never;
const query = { authorizeMutation: jest.fn().mockResolvedValue(undefined) } as never;
const transfer = { notifyNewAssignees: jest.fn().mockResolvedValue(undefined) } as never;
const webhooksDispatch = { enqueue: jest.fn().mockResolvedValue(undefined) } as never;
const automationRunner = { runForTicketEvent: jest.fn() } as never;
const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined) } as never;
const access = { holds: jest.fn().mockResolvedValue(false) } as never;

describe("projects-tickets ancestry race — advisory lock serializes concurrent reparenting", () => {
  it("acquires the project mutation lock before checking the ancestry chain for a human-session user", async () => {
    const capturedExecuteValues: string[] = [];
    const svc = new ProjectsTicketsUpdateService(
      makeDb(capturedExecuteValues),
      dispatch,
      activity,
      query,
      transfer,
      webhooksDispatch,
      automationRunner,
      cache,
      access,
    );

    await svc.updateTicket(makeActor(), PROJECT_ID, TICKET_ID, { version: 1, parentTicketId: PROPOSED_PARENT_ID });

    const advisoryLockCalled = capturedExecuteValues.some((v) =>
      v.includes(`build:tickets:${ORG}:${PROJECT_ID}`),
    );
    expect(advisoryLockCalled).toBe(true);
  });

  it("acquires the project mutation lock before checking the epic chain for a human-session user", async () => {
    const capturedExecuteValues: string[] = [];
    const svc = new ProjectsTicketsUpdateService(
      makeDb(capturedExecuteValues),
      dispatch,
      activity,
      query,
      transfer,
      webhooksDispatch,
      automationRunner,
      cache,
      access,
    );

    await svc.updateTicket(makeActor(), PROJECT_ID, TICKET_ID, { version: 1, epicId: PROPOSED_PARENT_ID });

    const advisoryLockCalled = capturedExecuteValues.some((v) =>
      v.includes(`build:tickets:${ORG}:${PROJECT_ID}`),
    );
    expect(advisoryLockCalled).toBe(true);
  });

  it("does not add an extra lock when the system job path already acquired it", async () => {
    const capturedExecuteValues: string[] = [];
    const svc = new ProjectsTicketsUpdateService(
      makeDb(capturedExecuteValues),
      dispatch,
      activity,
      query,
      transfer,
      webhooksDispatch,
      automationRunner,
      cache,
      access,
    );

    const systemU = systemActor("integrations.git.webhook", ORG);

    await svc.updateTicket(systemU, PROJECT_ID, TICKET_ID, { version: 1, parentTicketId: PROPOSED_PARENT_ID });

    const lockHits = capturedExecuteValues.filter((v) =>
      v.includes(`build:tickets:${ORG}:${PROJECT_ID}`),
    );
    expect(lockHits.length).toBe(1);
  });
});
