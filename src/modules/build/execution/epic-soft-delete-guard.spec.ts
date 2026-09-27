import { NotFoundException } from "@nestjs/common";
import { is, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { EpicsService } from "./epics.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { Test } from "@nestjs/testing";

const dialect = new PgDialect();

function renderSql(pred: unknown): string {
  if (!is(pred, SQL)) return "";
  return dialect.sqlToQuery(pred).sql;
}

function makeDb(returning: unknown[]) {
  const whereCaptures: unknown[] = [];
  const updateChain = {
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockImplementation((pred: unknown) => {
      whereCaptures.push(pred);
      return updateChain;
    }),
    returning: jest.fn().mockResolvedValue(returning),
  };
  const db = { update: jest.fn().mockReturnValue(updateChain) };
  return { db, updateChain, whereCaptures };
}

async function createService(returning: unknown[]) {
  const { db, updateChain, whereCaptures } = makeDb(returning);
  const module = await Test.createTestingModule({
    providers: [EpicsService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return { service: module.get(EpicsService), updateChain, whereCaptures, module };
}

describe("EpicsService.updateEpic — soft-deleted epic is rejected as not found", () => {
  it("throws NotFoundException when the DB returns no row so a soft-deleted epic cannot be modified", async () => {
    const { service, module } = await createService([]);
    await expect(service.updateEpic("org-1", 1, 99, { title: "renamed" })).rejects.toThrow(NotFoundException);
    await module.close();
  });

  it("returns the updated row when the epic exists and is not deleted", async () => {
    const row = { id: 5, orgId: "org-1", projectId: 1, title: "Epic", type: "EPIC", deletedAt: null };
    const { service, module } = await createService([row]);
    const result = await service.updateEpic("org-1", 1, 5, { title: "Epic" });
    expect(result).toEqual(row);
    await module.close();
  });

  it("WHERE predicate passed to update contains 'deleted_at' so the DB filters soft-deleted rows at the query level", async () => {
    const { service, whereCaptures, module } = await createService([]);
    await service.updateEpic("org-1", 1, 9, { title: "x" }).catch(() => undefined);
    expect(whereCaptures).toHaveLength(1);
    expect(renderSql(whereCaptures[0])).toContain("deleted_at");
    await module.close();
  });
});
