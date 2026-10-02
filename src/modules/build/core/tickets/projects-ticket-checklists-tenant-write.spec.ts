import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { ProjectsTicketChecklistsService } from "./projects-ticket-checklists.service";
import type { Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { assertTicketReadAccess } from "../project-crud/project-access";

jest.mock("../project-crud/project-access", () => ({
  assertTicketReadAccess: jest.fn().mockResolvedValue(undefined),
}));

const dialect = new PgDialect();
const ORG = "org-chk-a";
const PROJECT = 5;
const TICKET = 11;
const CHECKLIST = 3;
const ITEM = 9;

const u: CurrentUserContext = {
  orgId: ORG,
  userId: "user-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
  principal: null as never,
};

function makeDb(captured: { wheres: unknown[] }) {
  const terminal = (rows: unknown[]) => ({
    returning: jest.fn().mockResolvedValue(rows),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  });
  const capture = jest.fn().mockImplementation((cond: unknown) => {
    captured.wheres.push(cond);
    return terminal([{ id: ITEM }]);
  });
  return {
    query: {
      tickets: { findFirst: jest.fn().mockResolvedValue({ id: TICKET }) },
      ticketChecklists: { findFirst: jest.fn().mockResolvedValue({ id: CHECKLIST }) },
      ticketChecklistItems: {
        findFirst: jest.fn().mockResolvedValue({ id: ITEM, checklistId: CHECKLIST }),
      },
    },
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: capture }) }),
    delete: jest.fn().mockReturnValue({ where: capture }),
  } as unknown as Db;
}

describe("ProjectsTicketChecklistsService — tenant-correlated writes", () => {
  beforeEach(() => {
    jest.mocked(assertTicketReadAccess).mockResolvedValue(undefined);
  });

  it("binds org_id when updating a checklist item", async () => {
    const captured = { wheres: [] as unknown[] };
    const service = new ProjectsTicketChecklistsService(makeDb(captured), { scopeFor: jest.fn() });

    await service.updateChecklistItem(u, PROJECT, TICKET, CHECKLIST, ITEM, { text: "x" });

    const query = dialect.sqlToQuery(captured.wheres[0] as SQL);
    expect(query.params).toEqual(expect.arrayContaining([ORG, ITEM]));
  });

  it("binds org_id when deleting a checklist item", async () => {
    const captured = { wheres: [] as unknown[] };
    const service = new ProjectsTicketChecklistsService(makeDb(captured), { scopeFor: jest.fn() });

    await service.deleteChecklistItem(u, PROJECT, TICKET, CHECKLIST, ITEM);

    const query = dialect.sqlToQuery(captured.wheres[0] as SQL);
    expect(query.params).toEqual(expect.arrayContaining([ORG, ITEM]));
  });
});
