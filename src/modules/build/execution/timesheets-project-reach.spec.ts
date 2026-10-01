import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { CacheService } from "../../../common/cache/cache.service";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { EntriesPeriodService } from "../../timesheets/core/entries-period.service";
import {
  MANAGER_STANDING,
  projectAccessRow,
  standingAccess,
  type ProjectAccessRow,
  type StandingScopes,
} from "../core/project-crud/__tests__/project-access-doubles";
import { TimesheetsService } from "./timesheets.service";

const PROJECT_ID = 7;
const TICKET_ID = 70;
const MEMBERSHIP_ID = 21;

const actor: CurrentUserContext = {
  userId: "user-21",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(MEMBERSHIP_ID, false),
};

const TIMESHEET_MEMBER: StandingScopes = {
  "build:view": "own",
  "build:timesheets:manage": "all",
  "build:tickets:view": "all",
};

function rendered(where: SQL | undefined): string {
  if (where === undefined) return "";
  return new PgDialect().sqlToQuery(where).sql;
}

function makeDb(project: ProjectAccessRow | null) {
  const projectRows = project === null ? [] : [project];
  const findMany = jest.fn().mockResolvedValue([]);
  const ticketFindFirst = jest.fn().mockResolvedValue({ id: TICKET_ID });
  const countWhere = jest.fn().mockResolvedValue([{ total: 0 }]);
  const billingWhere = jest.fn(() => ({ groupBy: () => Promise.resolve([]) }));
  const billingChain = { innerJoin: () => billingChain, where: billingWhere };
  const select = jest.fn((fields?: object) => {
    if (fields !== undefined && "memberRole" in fields)
      return { from: () => ({ where: () => ({ limit: () => Promise.resolve(projectRows) }) }) };
    if (fields !== undefined && "totalHours" in fields) return { from: () => billingChain };
    return { from: () => ({ where: countWhere }) };
  });
  return {
    select,
    findMany,
    billingWhere,
    query: { timesheets: { findMany }, tickets: { findFirst: ticketFindFirst } },
  };
}

async function build(project: ProjectAccessRow | null, scopes: StandingScopes = TIMESHEET_MEMBER) {
  const db = makeDb(project);
  const cache = {
    cachedVersioned: jest.fn((_namespace: string, _key: string, fetcher: () => Promise<unknown>) => fetcher()),
    invalidateNamespace: jest.fn(),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      TimesheetsService,
      { provide: DRIZZLE, useValue: db },
      { provide: CacheService, useValue: cache },
      { provide: AccessService, useValue: standingAccess(scopes) },
      { provide: EntriesPeriodService, useValue: {} },
    ],
  }).compile();
  return { db, svc: moduleRef.get(TimesheetsService) };
}

function listedWhere(db: ReturnType<typeof makeDb>): string {
  const options: { where?: SQL } | undefined = db.findMany.mock.calls[0]?.[0];
  return rendered(options?.where);
}

describe("Build time entries are limited to projects the caller reaches", () => {
  it("GET /build/:projectId/tickets/:ticketId/time-entries conceals a same-org project the caller does not reach as 404", async () => {
    const { db, svc } = await build(projectAccessRow());
    await expect(svc.listTicketTimeEntries(actor, PROJECT_ID, TICKET_ID, { limit: 20 })).rejects.toThrow(NotFoundException);
    expect(db.findMany).not.toHaveBeenCalled();
  });

  it("GET /build/:projectId/tickets/:ticketId/time-entries answers 404 for a project outside the caller's organisation", async () => {
    const { db, svc } = await build(null);
    await expect(svc.listTicketTimeEntries(actor, PROJECT_ID, TICKET_ID, { limit: 20 })).rejects.toThrow(NotFoundException);
    expect(db.findMany).not.toHaveBeenCalled();
  });

  it("GET /build/:projectId/tickets/:ticketId/time-entries lists entries for a project member", async () => {
    const { db, svc } = await build(projectAccessRow({ memberRole: "MEMBER" }));
    await expect(svc.listTicketTimeEntries(actor, PROJECT_ID, TICKET_ID, { limit: 20 })).resolves.toBeDefined();
    expect(db.findMany).toHaveBeenCalledTimes(1);
  });

  it("GET /build/time-entries keeps the caller's own entries and otherwise only entries on projects they reach", async () => {
    const { db, svc } = await build(projectAccessRow());
    await svc.listTimeEntries(actor, { limit: 20 });
    const where = listedWhere(db);
    expect(where).toContain('"timesheets"."user_membership_id" =');
    expect(where).toContain('"timesheets"."project_id" IN (SELECT "build"."projects"."id"');
    expect(where).toContain('"project_members"');
  });

  it("GET /build/time-entries/team applies the same project reach before the timesheet scope", async () => {
    const { db, svc } = await build(projectAccessRow());
    await svc.teamTimesheets(actor, { limit: 20 });
    expect(listedWhere(db)).toContain('"timesheets"."project_id" IN (SELECT "build"."projects"."id"');
  });

  it("GET /build/billing-summary groups only entries on reachable projects or the caller's own", async () => {
    const { db, svc } = await build(projectAccessRow(), { ...TIMESHEET_MEMBER, "build:manage": "own" });
    await svc.billingSummary(actor, {});
    const where: SQL | undefined = db.billingWhere.mock.calls[0]?.[0];
    expect(rendered(where)).toContain('"build"."tickets"."project_id" IN (SELECT "build"."projects"."id"');
  });

  it("an organisation-wide build:manage holder reaches every project, so the reach clause is a tautology (control)", async () => {
    const { db, svc } = await build(projectAccessRow(), { ...MANAGER_STANDING, "build:timesheets:manage": "all" });
    await svc.listTimeEntries(actor, { limit: 20 });
    const where = listedWhere(db);
    expect(where).toContain('"build"."projects"."org_id" = $3 AND true)');
    expect(where).not.toContain('"project_members"');
  });
});
