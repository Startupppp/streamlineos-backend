import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { ProjectsTicketChecklistsService } from "./projects-ticket-checklists.service";
import type { Db } from "../../../db/drizzle.module";

const dialect = new PgDialect();
const ORG = "org-chk-a";
const PROJECT = 5;
const TICKET = 11;
const CHECKLIST = 3;
const ITEM = 9;

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

/**
 * The 404 was decided in JavaScript from a joined read, then the write went out
 * keyed on the item id alone. The item row carries org_id, so the predicate costs
 * nothing and denies correctly if the read is ever changed or bypassed.
 */
describe("ProjectsTicketChecklistsService — tenant-correlated writes", () => {
  it("binds org_id when updating a checklist item", async () => {
    const captured = { wheres: [] as unknown[] };
    const service = new ProjectsTicketChecklistsService(makeDb(captured));

    await service.updateChecklistItem(ORG, PROJECT, TICKET, CHECKLIST, ITEM, { text: "x" });

    const query = dialect.sqlToQuery(captured.wheres[0] as SQL);
    expect(query.params).toEqual(expect.arrayContaining([ORG, ITEM]));
  });

  it("binds org_id when deleting a checklist item", async () => {
    const captured = { wheres: [] as unknown[] };
    const service = new ProjectsTicketChecklistsService(makeDb(captured));

    await service.deleteChecklistItem(ORG, PROJECT, TICKET, CHECKLIST, ITEM);

    const query = dialect.sqlToQuery(captured.wheres[0] as SQL);
    expect(query.params).toEqual(expect.arrayContaining([ORG, ITEM]));
  });
});
