import { NotFoundException } from "@nestjs/common";
import { ProjectsTicketsReadService } from "./projects-tickets-read.service";
import type { AccessService } from "../../../access/access.service";
import type { Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import {
  MANAGER_STANDING,
  MEMBER_STANDING,
  projectAccessRow,
  standingAccess,
  type ProjectAccessRow,
  type StandingScopes,
} from "../../__tests__/project-access-doubles";

const ORG_ID = "org-col-agg";
const PROJECT_ID = 42;
const CALLER_MEMBERSHIP_ID = 7;

const USER: CurrentUserContext = {
  userId: "user-1",
  orgId: ORG_ID,
  role: "EMPLOYEE",
  isOrgOwner: false,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(CALLER_MEMBERSHIP_ID, true),
};

function accessDouble(scopes: StandingScopes): AccessService {
  return standingAccess(scopes) as unknown as AccessService;
}

interface DbDouble {
  db: Db;
  findManyCalls: () => number;
}

function buildDb(options: {
  project: ProjectAccessRow | null;
  aggregateRows: Array<{ status: string; cnt: string }>;
}): DbDouble {
  let findManyCallCount = 0;

  const db = {
    select: jest.fn(() => {
      const chain: Record<string, unknown> = {};
      chain["from"] = jest.fn(() => chain);
      chain["innerJoin"] = jest.fn(() => chain);
      chain["where"] = jest.fn(() => chain);
      chain["limit"] = jest.fn(() => Promise.resolve(options.project ? [options.project] : []));
      chain["groupBy"] = jest.fn(() => Promise.resolve(options.aggregateRows));
      return chain;
    }),
    query: {
      tickets: {
        findMany: jest.fn(() => {
          findManyCallCount++;
          return Promise.resolve([]);
        }),
      },
    },
  } as unknown as Db;

  return { db, findManyCalls: () => findManyCallCount };
}

describe("getColumnCounts — server aggregate, never a full fetch", () => {
  it("resolves counts from a GROUP BY aggregate, not from findMany", async () => {
    const aggregateRows = [
      { status: "TODO", cnt: "12" },
      { status: "IN_PROGRESS", cnt: "5" },
      { status: "DONE", cnt: "88" },
    ];
    const { db, findManyCalls } = buildDb({
      project: projectAccessRow(),
      aggregateRows,
    });

    const svc = new ProjectsTicketsReadService(db, accessDouble(MANAGER_STANDING));
    const result = await svc.getColumnCounts(USER, PROJECT_ID);

    expect(findManyCalls()).toBe(0);
    expect(result).toEqual({ TODO: 12, IN_PROGRESS: 5, DONE: 88 });
  });

  it("returns an empty record when the project has no tickets", async () => {
    const { db } = buildDb({
      project: projectAccessRow(),
      aggregateRows: [],
    });

    const svc = new ProjectsTicketsReadService(db, accessDouble(MANAGER_STANDING));

    expect(await svc.getColumnCounts(USER, PROJECT_ID)).toEqual({});
  });
});

describe("getColumnCounts — project access gate", () => {
  it("throws NotFound for a caller who is neither manager, member nor team member", async () => {
    const { db } = buildDb({
      project: projectAccessRow(),
      aggregateRows: [{ status: "TODO", cnt: "12" }],
    });

    const svc = new ProjectsTicketsReadService(db, accessDouble(MEMBER_STANDING));

    await expect(svc.getColumnCounts(USER, PROJECT_ID)).rejects.toThrow(NotFoundException);
  });

  it("throws NotFound when the project is absent from the caller's org", async () => {
    const { db } = buildDb({
      project: null,
      aggregateRows: [],
    });

    const svc = new ProjectsTicketsReadService(db, accessDouble(MEMBER_STANDING));

    await expect(svc.getColumnCounts(USER, PROJECT_ID)).rejects.toThrow(NotFoundException);
  });

  it("counts for a direct project member without build:manage", async () => {
    const { db } = buildDb({
      project: projectAccessRow({ memberRole: "CONTRIBUTOR" }),
      aggregateRows: [{ status: "TODO", cnt: "3" }],
    });

    const svc = new ProjectsTicketsReadService(db, accessDouble(MEMBER_STANDING));

    expect(await svc.getColumnCounts(USER, PROJECT_ID)).toEqual({ TODO: 3 });
  });

  it("returns an empty record when the caller's ticket scope is none", async () => {
    const { db } = buildDb({
      project: projectAccessRow(),
      aggregateRows: [{ status: "TODO", cnt: "3" }],
    });

    const svc = new ProjectsTicketsReadService(db, accessDouble({ "build:manage": "all" }));

    expect(await svc.getColumnCounts(USER, PROJECT_ID)).toEqual({});
  });
});
