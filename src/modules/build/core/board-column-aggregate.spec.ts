import { NotFoundException } from "@nestjs/common";
import { ProjectsTicketsReadService } from "./tickets/projects-tickets-read.service";
import type { AccessService } from "../../access/access.service";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

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

function accessDouble(scope: string, perms: string[]): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set(perms)),
    scopeFor: jest.fn().mockResolvedValue(scope),
  } as unknown as AccessService;
}

interface DbDouble {
  db: Db;
  findManyCalls: () => number;
}

function buildDb(options: {
  project: { managerMembershipId: number | null } | null;
  memberRows: unknown[];
  teamRows: unknown[];
  aggregateRows: Array<{ status: string; cnt: string }>;
}): DbDouble {
  let selectCallCount = 0;
  let findManyCallCount = 0;
  const selectResults: unknown[][] = [options.memberRows, options.teamRows];

  const db = {
    select: jest.fn(() => {
      const index = selectCallCount;
      selectCallCount++;
      const chain: Record<string, unknown> = {};
      chain["from"] = jest.fn(() => chain);
      chain["innerJoin"] = jest.fn(() => chain);
      chain["where"] = jest.fn(() => chain);
      chain["limit"] = jest.fn(() => Promise.resolve(selectResults[index] ?? []));
      chain["groupBy"] = jest.fn(() => Promise.resolve(options.aggregateRows));
      return chain;
    }),
    query: {
      projects: { findFirst: jest.fn(() => Promise.resolve(options.project)) },
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
      project: { managerMembershipId: null },
      memberRows: [],
      teamRows: [],
      aggregateRows,
    });

    const svc = new ProjectsTicketsReadService(db, accessDouble("all", ["build:manage"]));
    const result = await svc.getColumnCounts(USER, PROJECT_ID);

    expect(findManyCalls()).toBe(0);
    expect(result).toEqual({ TODO: 12, IN_PROGRESS: 5, DONE: 88 });
  });

  it("returns an empty record when the project has no tickets", async () => {
    const { db } = buildDb({
      project: { managerMembershipId: null },
      memberRows: [],
      teamRows: [],
      aggregateRows: [],
    });

    const svc = new ProjectsTicketsReadService(db, accessDouble("all", ["build:manage"]));

    expect(await svc.getColumnCounts(USER, PROJECT_ID)).toEqual({});
  });
});

describe("getColumnCounts — project access gate", () => {
  it("throws NotFound for a caller who is neither manager, member nor team member", async () => {
    const { db } = buildDb({
      project: { managerMembershipId: 999 },
      memberRows: [],
      teamRows: [],
      aggregateRows: [{ status: "TODO", cnt: "12" }],
    });

    const svc = new ProjectsTicketsReadService(db, accessDouble("all", []));

    await expect(svc.getColumnCounts(USER, PROJECT_ID)).rejects.toThrow(NotFoundException);
  });

  it("throws NotFound when the project is absent from the caller's org", async () => {
    const { db } = buildDb({
      project: null,
      memberRows: [],
      teamRows: [],
      aggregateRows: [],
    });

    const svc = new ProjectsTicketsReadService(db, accessDouble("all", []));

    await expect(svc.getColumnCounts(USER, PROJECT_ID)).rejects.toThrow(NotFoundException);
  });

  it("counts for a direct project member without build:manage", async () => {
    const { db } = buildDb({
      project: { managerMembershipId: 999 },
      memberRows: [{ id: 7, role: "CONTRIBUTOR" }],
      teamRows: [],
      aggregateRows: [{ status: "TODO", cnt: "3" }],
    });

    const svc = new ProjectsTicketsReadService(db, accessDouble("all", ["build:tickets:view"]));

    expect(await svc.getColumnCounts(USER, PROJECT_ID)).toEqual({ TODO: 3 });
  });

  it("returns an empty record when the caller's ticket scope is none", async () => {
    const { db } = buildDb({
      project: { managerMembershipId: null },
      memberRows: [],
      teamRows: [],
      aggregateRows: [{ status: "TODO", cnt: "3" }],
    });

    const svc = new ProjectsTicketsReadService(db, accessDouble("none", ["build:manage"]));

    expect(await svc.getColumnCounts(USER, PROJECT_ID)).toEqual({});
  });
});
