import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { ticketComments, tickets } from "../../../../db/schema";
import { ProjectsWriteService } from "./projects-write.service";
import { standingAccess } from "../../__tests__/project-access-doubles";

const dialect = new PgDialect();

function render(condition: SQL): string {
  return dialect.sqlToQuery(condition).sql;
}

describe("ProjectsWriteService.deleteProject — preserves earlier soft deletes", () => {
  it("does not restamp already-deleted tickets or comments", async () => {
    const updates: Array<{ table: unknown; where: SQL }> = [];
    const update = jest.fn((table: unknown) => ({
      set: jest.fn(() => ({
        where: jest.fn(async (where: SQL) => {
          updates.push({ table, where });
        }),
      })),
    }));
    const tx = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({})),
        })),
      })),
      update,
    };
    const db = {
      query: {
        projects: {
          findFirst: jest.fn().mockResolvedValue({ id: 10, name: "Project" }),
        },
      },
      transaction: jest.fn(async (callback: (value: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as Db;
    const service = new ProjectsWriteService(
      db,
      { log: jest.fn() } as never,
      standingAccess({ "build:delete": "all" }) as never,
      {} as never,
    );

    await service.deleteProject(
      { orgId: "org-1", userId: "user-1", isOrgOwner: true } as never,
      10,
    );

    const commentWhere = updates.find((entry) => entry.table === ticketComments)?.where;
    const ticketWhere = updates.find((entry) => entry.table === tickets)?.where;
    expect(commentWhere).toBeDefined();
    expect(ticketWhere).toBeDefined();
    expect(render(commentWhere!)).toContain('"deleted_at" is null');
    expect(render(ticketWhere!)).toContain('"deleted_at" is null');
  });
});
