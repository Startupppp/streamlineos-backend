import { NotFoundException } from "@nestjs/common";
import { is, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { EpicsService } from "./epics.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { BuildTicketCreationService, ProjectsTicketsUpdateService } from "../core/tickets";
import { Test } from "@nestjs/testing";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const ACTOR: CurrentUserContext = {
  userId: "u-owner",
  orgId: "org-1",
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

const dialect = new PgDialect();

function renderSql(pred: unknown): string {
  if (!is(pred, SQL)) return "";
  return dialect.sqlToQuery(pred).sql;
}

async function createService(beforeRow: unknown, afterRow: unknown = beforeRow) {
  const lookupWheres: unknown[] = [];
  const findFirst = jest
    .fn()
    .mockImplementationOnce(async (args: { where: unknown }) => {
      lookupWheres.push(args.where);
      return beforeRow;
    })
    .mockResolvedValueOnce(afterRow);
  const updateTicket = jest.fn().mockResolvedValue(undefined);
  const module = await Test.createTestingModule({
    providers: [
      EpicsService,
      { provide: DRIZZLE, useValue: { query: { tickets: { findFirst } } } },
      { provide: BuildTicketCreationService, useValue: { createInTransaction: jest.fn(), publish: jest.fn() } },
      { provide: ProjectsTicketsUpdateService, useValue: { updateTicket } },
      { provide: AccessService, useValue: {} },
    ],
  }).compile();
  return { service: module.get(EpicsService), updateTicket, lookupWheres, module };
}

describe("EpicsService.updateEpic — soft-deleted epic is rejected as not found", () => {
  it("throws NotFoundException and never reaches the ticket update when the epic is missing or soft-deleted", async () => {
    const { service, updateTicket, module } = await createService(undefined);
    await expect(
      service.updateEpic(ACTOR, 1, 99, { title: "renamed", version: 1, startDate: undefined, dueDate: undefined }),
    ).rejects.toThrow(NotFoundException);
    expect(updateTicket).not.toHaveBeenCalled();
    await module.close();
  });

  it("routes a live epic through the canonical ticket update and returns the re-read row", async () => {
    const row = { id: 5, orgId: "org-1", projectId: 1, title: "Epic", type: "EPIC", deletedAt: null, version: 2 };
    const { service, updateTicket, module } = await createService({ id: 5, version: 1 }, row);
    const result = await service.updateEpic(ACTOR, 1, 5, { title: "Epic", version: 1, startDate: undefined, dueDate: undefined });
    expect(result).toEqual(row);
    expect(updateTicket).toHaveBeenCalledWith(ACTOR, 1, 5, { version: 1, title: "Epic" });
    await module.close();
  });

  it("the epic lookup filters deleted_at so a soft-deleted epic is invisible to the update", async () => {
    const { service, lookupWheres, module } = await createService(undefined);
    await service
      .updateEpic(ACTOR, 1, 9, { title: "x", version: 1, startDate: undefined, dueDate: undefined })
      .catch(() => undefined);
    expect(lookupWheres).toHaveLength(1);
    expect(renderSql(lookupWheres[0])).toContain("deleted_at");
    await module.close();
  });
});
