import { ForbiddenException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { BuildTicketCreationService } from "../core/tickets";
import { IntakeService, ViewsService } from "./workspace.service";
import { createIntakeSchema, createViewSchema } from "./dto/workspace.schemas";

const ORG = "org-1";
const PROJECT_ID = 1;
const MEMBERSHIP_ID = 7;

const actor: CurrentUserContext = {
  userId: "user-1",
  orgId: ORG,
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s1",
  tokenScopes: null,
  principal: humanSessionPrincipal(MEMBERSHIP_ID, false),
};

const access = {
  resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
} as unknown as AccessService;

const row = {
  id: 3,
  projectId: PROJECT_ID,
  orgId: ORG,
  title: "Request",
  description: "",
  status: "pending",
  createdBy: "user-1",
  visibility: "private",
  isPinned: false,
  createdAt: new Date("2026-09-01T00:00:00Z"),
  updatedAt: new Date("2026-09-01T00:00:00Z"),
};

function makeDb(isProjectManager: boolean) {
  const chain: Record<string, jest.Mock> = {};
  const self = () => chain;
  for (const step of ["from", "innerJoin", "leftJoin", "where", "orderBy"]) chain[step] = jest.fn(self);
  chain["limit"] = jest.fn(() => Promise.resolve(isProjectManager ? [row] : []));
  const returning = jest.fn(() => Promise.resolve([row]));
  const insert = jest.fn(() => ({ values: () => ({ returning }) }));
  const update = jest.fn(() => ({ set: () => ({ where: () => ({ returning }) }) }));
  const del = jest.fn(() => ({ where: () => Promise.resolve(undefined) }));
  const db = {
    query: {
      projects: {
        findFirst: jest.fn().mockResolvedValue({ managerMembershipId: isProjectManager ? MEMBERSHIP_ID : 999 }),
      },
      projectViews: { findFirst: jest.fn().mockResolvedValue(row) },
    },
    select: jest.fn(self),
    insert,
    update,
    delete: del,
  } as unknown as Db;
  return { db, writes: () => insert.mock.calls.length + update.mock.calls.length + del.mock.calls.length, chain };
}

const ticketCreation = {} as BuildTicketCreationService;

const surfaces: readonly [string, boolean, (db: Db) => Promise<unknown>][] = [
  ["listIntake", false, (db) => new IntakeService(db, ticketCreation, access).listIntake(actor, PROJECT_ID, { limit: 10 })],
  [
    "createIntake",
    true,
    (db) =>
      new IntakeService(db, ticketCreation, access).createIntake(
        actor,
        PROJECT_ID,
        createIntakeSchema.parse({ title: "Intake", submitterEmail: "intake@example.com" }),
      ),
  ],
  [
    "updateIntake",
    true,
    (db) =>
      new IntakeService(db, ticketCreation, access).updateIntake(actor, PROJECT_ID, row.id, {
        status: "declined",
        declineReason: "out of scope",
      }),
  ],
  ["listViews", false, (db) => new ViewsService(db, access).listViews(actor, PROJECT_ID, { limit: 25 })],
  ["createView", true, (db) => new ViewsService(db, access).createView(actor, PROJECT_ID, createViewSchema.parse({ name: "Board" }))],
  ["updateView", true, (db) => new ViewsService(db, access).updateView(actor, PROJECT_ID, row.id, { name: "Renamed" })],
  ["deleteView", true, (db) => new ViewsService(db, access).deleteView(actor, PROJECT_ID, row.id)],
];

describe("intake and saved views require membership of the URL project, like the milestones beside them", () => {
  it.each(surfaces)("%s refuses a same-org non-member with 403 before touching intake or view rows", async (_name, _writes, run) => {
    const { db, writes, chain } = makeDb(false);
    await expect(run(db)).rejects.toThrow(ForbiddenException);
    expect(writes()).toBe(0);
    expect(chain["orderBy"]).not.toHaveBeenCalled();
  });

  it.each(surfaces)("%s proceeds for the project's manager (paired control)", async (_name, isWrite, run) => {
    const { db, writes } = makeDb(true);
    await expect(run(db)).resolves.toBeDefined();
    expect(writes()).toBe(isWrite ? 1 : 0);
  });
});
