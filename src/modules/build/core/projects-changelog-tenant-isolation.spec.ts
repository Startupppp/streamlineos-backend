import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { ProjectsChangelogService } from "./projects-changelog.service";
import type { Db } from "../../../db/drizzle.module";

const dialect = new PgDialect();
const ORG = "org-a";
const OTHER_ORG = "org-b";

function render(value: unknown): string {
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

function bindings(value: unknown): unknown[] {
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).params;
}

interface Captured {
  findManyWhere: unknown;
  findFirstWhere: unknown;
  updateWhere: unknown;
  deleteWhere: unknown;
}

interface Chain {
  set: jest.Mock;
  values: jest.Mock;
  where: jest.Mock;
  returning: jest.Mock;
}

function buildDb(captured: Captured, rows: unknown[]): Db {
  const updateChain: Chain = {
    set: jest.fn(() => updateChain),
    values: jest.fn(() => updateChain),
    where: jest.fn((cond: unknown) => {
      captured.updateWhere = cond;
      return updateChain;
    }),
    returning: jest.fn(() => Promise.resolve(rows)),
  };
  const deleteChain: Chain = {
    set: jest.fn(() => deleteChain),
    values: jest.fn(() => deleteChain),
    where: jest.fn((cond: unknown) => {
      captured.deleteWhere = cond;
      return deleteChain;
    }),
    returning: jest.fn(() => Promise.resolve(rows)),
  };
  const insertChain: Chain = {
    set: jest.fn(() => insertChain),
    values: jest.fn(() => insertChain),
    where: jest.fn(() => insertChain),
    returning: jest.fn(() => Promise.resolve(rows)),
  };
  return {
    query: {
      changelogEntries: {
        findMany: jest.fn((args: { where: unknown }) => {
          captured.findManyWhere = args.where;
          return Promise.resolve([]);
        }),
        findFirst: jest.fn((args: { where: unknown }) => {
          captured.findFirstWhere = args.where;
          return Promise.resolve(rows[0] ?? undefined);
        }),
      },
      roadmapItems: { findFirst: jest.fn(() => Promise.resolve(undefined)) },
    },
    update: jest.fn(() => updateChain),
    delete: jest.fn(() => deleteChain),
    insert: jest.fn(() => insertChain),
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve([])) })),
      })),
    })),
  } as unknown as Db;
}

function empty(): Captured {
  return {
    findManyWhere: undefined,
    findFirstWhere: undefined,
    updateWhere: undefined,
    deleteWhere: undefined,
  };
}

describe("ProjectsChangelogService — cross-tenant isolation", () => {
  it("binds the caller's org into the list predicate", async () => {
    const captured = empty();
    const svc = new ProjectsChangelogService(buildDb(captured, []));
    await svc.listChangelog(ORG, { limit: 20, cursor: undefined, type: undefined });
    expect(render(captured.findManyWhere)).toContain('"org_id"');
    expect(bindings(captured.findManyWhere)).toContain(ORG);
    expect(bindings(captured.findManyWhere)).not.toContain(OTHER_ORG);
  });

  it("scopes a single-entry read to the caller's org", async () => {
    const captured = empty();
    const svc = new ProjectsChangelogService(buildDb(captured, []));
    await expect(svc.getChangelog(ORG, 5)).rejects.toThrow(NotFoundException);
    expect(render(captured.findFirstWhere)).toContain('"org_id"');
    expect(bindings(captured.findFirstWhere)).toContain(ORG);
  });

  it("refuses to update an entry that belongs to another org", async () => {
    const captured = empty();
    const svc = new ProjectsChangelogService(buildDb(captured, []));
    await expect(svc.updateChangelog(ORG, 5, { title: "x" })).rejects.toThrow(
      NotFoundException,
    );
    expect(bindings(captured.findFirstWhere)).toContain(ORG);
  });

  it("carries the org predicate on the delete statement itself", async () => {
    const captured = empty();
    const svc = new ProjectsChangelogService(buildDb(captured, []));
    await expect(svc.deleteChangelog(ORG, 5)).rejects.toThrow(NotFoundException);
    expect(render(captured.deleteWhere)).toContain('"org_id"');
    expect(bindings(captured.deleteWhere)).toContain(ORG);
  });

  it("rejects a linked roadmap item that is not in the caller's org", async () => {
    const captured = empty();
    const svc = new ProjectsChangelogService(buildDb(captured, []));
    await expect(
      svc.createChangelog(ORG, "user-1", {
        title: "Release",
        content: "",
        type: "feature",
        isPublished: false,
        linkedRoadmapItemId: 99,
      }),
    ).rejects.toThrow(NotFoundException);
  });
});
