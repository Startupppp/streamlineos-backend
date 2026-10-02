import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { WhiteboardsService } from "./whiteboards.service";
import { projectAccessRow } from "../__tests__/project-access-doubles";

const PROJECT_ID = 7;
const BOARD_ID = 3;
const CALLER_MEMBERSHIP = 21;
const dialect = new PgDialect();

function callerWith(isOrgOwner: boolean): CurrentUserContext {
  return {
    userId: "user-21",
    orgId: "org-1",
    role: isOrgOwner ? "OWNER" : "MEMBER",
    isOrgOwner,
    sessionId: "s",
    tokenScopes: null,
    principal: humanSessionPrincipal(CALLER_MEMBERSHIP, isOrgOwner),
  };
}

const caller = callerWith(false);

type Standing = "member" | "non-member" | "foreign";

const PROJECT_BOARD = {
  id: BOARD_ID,
  orgId: "org-1",
  projectId: PROJECT_ID,
  name: "Roadmap",
  data: { elements: [] },
  visibility: "project",
  publicAccess: "viewer",
  shareToken: null,
  linkExpiresAt: null,
  allowExport: true,
  createdBy: "someone-else",
  deletedAt: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
};

type QueryChain = {
  from: jest.Mock;
  innerJoin: jest.Mock;
  leftJoin: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
};

async function build(standing: Standing) {
  const listWheres: SQL[] = [];
  const projectRows = standing === "foreign" ? [] : [projectAccessRow({ manages: standing === "member" })];
  const select = jest.fn((projection: Record<string, unknown>) => {
    const rows = "board" in projection
      ? [{ board: PROJECT_BOARD, shareRole: null }]
      : "onTeam" in projection
        ? projectRows
        : [];
    const chain: QueryChain = {
      from: jest.fn(),
      leftJoin: jest.fn(),
      innerJoin: jest.fn(),
      where: jest.fn((where: SQL) => {
        if ("visibility" in projection) listWheres.push(where);
        return chain;
      }),
      orderBy: jest.fn(),
      limit: jest.fn().mockResolvedValue(rows),
    };
    chain.from.mockReturnValue(chain);
    chain.leftJoin.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    chain.orderBy.mockReturnValue(chain);
    return chain;
  });
  const returning = jest.fn().mockResolvedValue([{ ...PROJECT_BOARD, createdBy: caller.userId }]);
  const insert = jest.fn(() => ({ values: jest.fn(() => ({ returning })) }));
  const db = { select, insert };
  const access = {
    holds: jest.fn().mockResolvedValue(false),
    scopeFor: jest.fn(async (_user: CurrentUserContext, key: string) => (key === "build:view" ? "all" : "none")),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      WhiteboardsService,
      { provide: DRIZZLE, useValue: db },
      { provide: AccessService, useValue: access },
      { provide: AuditService, useValue: { log: jest.fn() } },
    ],
  }).compile();
  return { service: moduleRef.get(WhiteboardsService), insert, listWheres };
}

function rendered(where: SQL | undefined): string {
  if (where === undefined) throw new Error("the list was not read");
  const query = dialect.sqlToQuery(where);
  return `${query.sql} ${JSON.stringify(query.params)}`;
}

describe("a project-visible whiteboard is visible only to callers with access to its project", () => {
  it("GET /build/:projectId/whiteboards/:whiteboardId answers 404 to a same-org caller who is not on the project", async () => {
    const { service } = await build("non-member");
    await expect(service.getWhiteboard(caller, PROJECT_ID, BOARD_ID)).rejects.toThrow(NotFoundException);
  });

  it("GET /build/:projectId/whiteboards/:whiteboardId answers 404 for a project outside the caller's tenant", async () => {
    const { service } = await build("foreign");
    await expect(service.getWhiteboard(caller, PROJECT_ID, BOARD_ID)).rejects.toThrow(NotFoundException);
  });

  it("GET /build/:projectId/whiteboards/:whiteboardId returns view access to the project's manager", async () => {
    const { service } = await build("member");
    await expect(service.getWhiteboard(caller, PROJECT_ID, BOARD_ID)).resolves.toMatchObject({ access: "view" });
  });

  it("GET /build/:projectId/whiteboards omits project-visible boards for a caller who is not on the project", async () => {
    const { service, listWheres } = await build("non-member");
    await service.listWhiteboards(caller, PROJECT_ID, { limit: 20 });
    expect(rendered(listWheres[0])).not.toContain('"project"');
  });

  it("GET /build/:projectId/whiteboards includes project-visible boards for the project's manager", async () => {
    const { service, listWheres } = await build("member");
    await service.listWhiteboards(caller, PROJECT_ID, { limit: 20 });
    expect(rendered(listWheres[0])).toContain('"project"');
  });
});

describe("POST /build/:projectId/whiteboards requires access to the project", () => {
  it("answers 403 to a same-org caller who is not on the project, without creating a board", async () => {
    const { service, insert } = await build("non-member");
    await expect(service.createWhiteboard(caller, PROJECT_ID, { name: "Plan" })).rejects.toThrow(ForbiddenException);
    expect(insert).not.toHaveBeenCalled();
  });

  it("answers 404 for a project outside the caller's tenant, without creating a board", async () => {
    const { service, insert } = await build("foreign");
    await expect(service.createWhiteboard(caller, PROJECT_ID, { name: "Plan" })).rejects.toThrow(NotFoundException);
    expect(insert).not.toHaveBeenCalled();
  });

  it("creates the board for the project's manager", async () => {
    const { service, insert } = await build("member");
    await expect(service.createWhiteboard(caller, PROJECT_ID, { name: "Plan" })).resolves.toMatchObject({
      access: "manage",
    });
    expect(insert).toHaveBeenCalledTimes(1);
  });
});

describe("GET /build/whiteboards limits project-visible boards to reachable projects", () => {
  it("restricts project-visible boards to the caller's reachable projects", async () => {
    const { service, listWheres } = await build("member");
    await service.listAllWhiteboards(caller);
    expect(rendered(listWheres[0])).toContain("project_members");
  });

  it("applies no visibility restriction for the org owner", async () => {
    const { service, listWheres } = await build("member");
    await service.listAllWhiteboards(callerWith(true));
    expect(rendered(listWheres[0])).not.toContain("project_members");
  });
});
