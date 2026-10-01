import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { ProjectsActivityFeedService } from "./projects-activity-feed.service";
import { MEMBER_STANDING, projectAccessRow, standingAccess } from "../project-crud/__tests__/project-access-doubles";

const PROJECT_ID = 7;
const CALLER_MEMBERSHIP = 21;
const dialect = new PgDialect();

const caller: CurrentUserContext = {
  userId: "user-21",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(CALLER_MEMBERSHIP, false),
};

type Standing = "member" | "non-member" | "foreign";

type QueryChain = {
  from: jest.Mock;
  innerJoin: jest.Mock;
  leftJoin: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
};

async function build(standing: Standing, ticketScope: "all" | "own" = "all") {
  const feedWheres: SQL[] = [];
  const projectRows =
    standing === "foreign" ? [] : [projectAccessRow({ manages: standing === "member" })];
  const select = jest.fn((projection: Record<string, unknown>) => {
    const chain: QueryChain = {
      from: jest.fn(),
      innerJoin: jest.fn(),
      leftJoin: jest.fn(),
      where: jest.fn((where: SQL) => {
        if ("action" in projection) feedWheres.push(where);
        return chain;
      }),
      orderBy: jest.fn(),
      limit: jest.fn().mockResolvedValue("manages" in projection ? projectRows : []),
    };
    chain.from.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    chain.leftJoin.mockReturnValue(chain);
    chain.orderBy.mockReturnValue(chain);
    return chain;
  });
  const db = { select };
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProjectsActivityFeedService,
      { provide: DRIZZLE, useValue: db },
      {
        provide: AccessService,
        useValue: standingAccess({ ...MEMBER_STANDING, "build:tickets:view": ticketScope }),
      },
    ],
  }).compile();
  return { service: moduleRef.get(ProjectsActivityFeedService), feedWheres };
}

describe("GET /build/:projectId/activity only shows the feed of a project the caller can reach", () => {
  it("answers 404 to a same-org caller who is not on the project, without reading the feed", async () => {
    const { service, feedWheres } = await build("non-member");
    await expect(service.getProjectActivity(caller, PROJECT_ID, { limit: 20 })).rejects.toThrow(NotFoundException);
    expect(feedWheres).toHaveLength(0);
  });

  it("answers 404 for a project outside the caller's tenant, without reading the feed", async () => {
    const { service, feedWheres } = await build("foreign");
    await expect(service.getProjectActivity(caller, PROJECT_ID, { limit: 20 })).rejects.toThrow(NotFoundException);
    expect(feedWheres).toHaveLength(0);
  });

  it("reads the feed for the project's manager", async () => {
    const { service, feedWheres } = await build("member");
    await expect(service.getProjectActivity(caller, PROJECT_ID, { limit: 20 })).resolves.toMatchObject({ data: [] });
    expect(feedWheres).toHaveLength(1);
  });

  const SCOPES: Array<["own" | "all", boolean]> = [
    ["own", true],
    ["all", false],
  ];

  it.each(SCOPES)("with ticket scope %s the feed predicate restricts to the caller's tickets: %s", async (scope, restricted) => {
    const { service, feedWheres } = await build("member", scope);
    await service.getProjectActivity(caller, PROJECT_ID, { limit: 20 });
    const [where] = feedWheres;
    if (where === undefined) throw new Error("the feed was not read");
    expect(dialect.sqlToQuery(where).sql.includes("reporter_id")).toBe(restricted);
  });
});
