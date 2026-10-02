import { NotFoundException } from "@nestjs/common";
import { is, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { EpicsService } from "./epics.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { BuildTicketCreationService, ProjectsTicketsUpdateService, ProjectsTicketsDeleteService } from "../core/tickets";
import { Test } from "@nestjs/testing";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const dialect = new PgDialect();

function renderSql(pred: unknown): string {
  if (!is(pred, SQL)) return "";
  return dialect.sqlToQuery(pred).sql;
}

function makeU(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    role: "member",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(10, false),
  };
}

function makeDb(firstFindResult: unknown = undefined, secondFindResult: unknown = undefined) {
  let call = 0;
  const findFirst = jest.fn().mockImplementation(() => {
    call++;
    return Promise.resolve(call === 1 ? firstFindResult : secondFindResult);
  });
  const db = {
    query: { tickets: { findFirst } },
  };
  return { db, findFirst };
}

async function createService(firstFindResult: unknown = undefined, secondFindResult: unknown = undefined) {
  const { db, findFirst } = makeDb(firstFindResult, secondFindResult);
  const updateTicket = jest.fn().mockResolvedValue(undefined);
  const module = await Test.createTestingModule({
    providers: [
      EpicsService,
      { provide: DRIZZLE, useValue: db },
      { provide: BuildTicketCreationService, useValue: { createInTransaction: jest.fn(), publish: jest.fn() } },
      { provide: ProjectsTicketsUpdateService, useValue: { updateTicket } },
      { provide: ProjectsTicketsDeleteService, useValue: { deleteTicket: jest.fn() } },
    ],
  }).compile();
  return { service: module.get(EpicsService), findFirst, updateTicket, module };
}

describe("EpicsService.updateEpic — soft-deleted epic is rejected as not found", () => {
  it("throws NotFoundException when the DB returns no row so a soft-deleted epic cannot be modified", async () => {
    const { service, module } = await createService(undefined);
    await expect(service.updateEpic(makeU(), 1, 99, { title: "renamed", version: 1, startDate: undefined, dueDate: undefined })).rejects.toThrow(NotFoundException);
    await module.close();
  });

  it("returns the updated row when the epic exists and is not deleted", async () => {
    const row = { id: 5, orgId: "org-1", projectId: 1, title: "Epic", type: "EPIC", deletedAt: null };
    const { service, module } = await createService({ id: 5, version: 1 }, row);
    const result = await service.updateEpic(makeU(), 1, 5, { title: "Epic", version: 1, startDate: undefined, dueDate: undefined });
    expect(result).toEqual(row);
    await module.close();
  });

  it("findFirst WHERE predicate contains 'deleted_at' so the DB filters soft-deleted rows before calling updateTicket", async () => {
    const { service, findFirst, module } = await createService({ id: 9, version: 1 }, { id: 9 });
    await service.updateEpic(makeU(), 1, 9, { title: "x", version: 1, startDate: undefined, dueDate: undefined }).catch(() => undefined);
    const firstCallArg = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(renderSql(firstCallArg?.where)).toContain("deleted_at");
    await module.close();
  });
});
