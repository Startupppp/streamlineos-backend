import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ACCOUNT_ONLY_PRINCIPAL, humanSessionPrincipal } from "../../../common/auth/principal";
import {
  MANAGER_STANDING,
  MEMBER_STANDING,
  standingAccess,
  type StandingScopes,
} from "../core/project-crud/__tests__/project-access-doubles";
import { CommentDraftsService } from "./comment-drafts.service";

const actor: CurrentUserContext = {
  userId: "user-21",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(21, false),
};

async function build(scopes: StandingScopes) {
  const where = jest.fn((_condition: SQL) => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }));
  const chain = { innerJoin: () => chain, leftJoin: () => chain, where };
  const select = jest.fn(() => ({ from: () => chain }));
  const moduleRef = await Test.createTestingModule({
    providers: [
      CommentDraftsService,
      { provide: DRIZZLE, useValue: { select } },
      { provide: AccessService, useValue: standingAccess(scopes) },
    ],
  }).compile();
  return { where, select, svc: moduleRef.get(CommentDraftsService) };
}

function renderedWhere(where: jest.Mock): string {
  const condition: SQL | undefined = where.mock.calls[0]?.[0];
  return condition === undefined ? "" : new PgDialect().sqlToQuery(condition).sql;
}

describe("GET /build/comment-drafts/mine applies the ticket visibility rule", () => {
  it("drops drafts on tickets in projects the caller no longer reaches", async () => {
    const built = await build(MEMBER_STANDING);
    await expect(built.svc.listMine(actor)).resolves.toEqual([]);
    const where = renderedWhere(built.where);
    expect(where).toContain('"comment_drafts"."membership_id" =');
    expect(where).toContain('"build"."tickets"."project_id" IN (SELECT "build"."projects"."id"');
    expect(where).toContain('"project_members"');
  });

  it("answers nothing to a caller with no Build standing, because the visibility rule reduces to false", async () => {
    const built = await build({});
    await built.svc.listMine(actor);
    expect(renderedWhere(built.where)).toContain("false");
  });

  it("refuses an actor without an organisation membership before reading", async () => {
    const built = await build(MANAGER_STANDING);
    await expect(built.svc.listMine({ ...actor, principal: ACCOUNT_ONLY_PRINCIPAL })).rejects.toThrow(ForbiddenException);
    expect(built.select).not.toHaveBeenCalled();
  });

  it("an organisation-wide build:manage holder keeps every own draft (control)", async () => {
    const built = await build(MANAGER_STANDING);
    await built.svc.listMine(actor);
    expect(renderedWhere(built.where)).not.toContain('"project_members"');
  });
});
