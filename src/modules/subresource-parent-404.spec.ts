import { NotFoundException } from "@nestjs/common";
import { ClientAccountsService } from "./clients/client-accounts.service";
import { InvoicesService } from "./invoices/invoices.service";
import { KbTagsService } from "./kb/core/kb-tags.service";
import { GoalLinksService } from "./goals/goal-links.service";
import { HrTravelVisitsService } from "./hr/benefits/hr-travel-visits.service";
import { CompPlanningService } from "./hr/enterprise-comp/comp-planning.service";
import { HrAutomationEngineService } from "./hr/automations/hr-automation-engine.service";
import type { Db } from "../db/drizzle.module";
import { ScopedRead } from "./access/scoped-read";

const stub = <T,>() => ({}) as T;
const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

function makeDb(parent: { id: number | string } | undefined) {
  const rows: unknown[] = [];
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const key of ["from", "where", "orderBy", "limit", "offset", "innerJoin", "leftJoin", "groupBy"])
    chain[key] = jest.fn(self);
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
  const findFirst = jest.fn().mockResolvedValue(parent);
  const findMany = jest.fn().mockResolvedValue(rows);
  return {
    query: {
      clientAccounts: { findFirst },
      clientAccountActivities: { findMany },
      invoices: { findFirst },
      payments: { findMany },
      kbPages: { findFirst },
      okrGoals: { findFirst },
      travelRequests: { findFirst },
      hrCompCycles: { findFirst },
      hrAutomationRules: { findFirst },
      hrAutomationRuns: { findMany },
    },
    select: jest.fn(self),
  } as unknown as Db;
}

describe("a sub-resource list whose parent id is outside the caller's org answers 404", () => {
  const cases: Array<[string, (db: Db, org: string) => Promise<unknown>]> = [
    [
      "GET /clients/:clientId/activities",
      (db, org) =>
        new ClientAccountsService(
          db,
          null,
          stub<ConstructorParameters<typeof ClientAccountsService>[2]>(),
          stub<ConstructorParameters<typeof ClientAccountsService>[3]>(),
          stub<ConstructorParameters<typeof ClientAccountsService>[4]>(),
        ).getClientActivities(ScopedRead.of(org, "caller", "all"), 1),
    ],
    [
      "GET /invoices/:invoiceId/payments",
      (db, org) =>
        new InvoicesService(db, stub<ConstructorParameters<typeof InvoicesService>[1]>()).getInvoicePayments(org, 1),
    ],
    ["GET /kb/articles/:articleId/tags", (db, org) => new KbTagsService(db).getArticleTags(org, 1)],
    ["GET /goals/:goalId/links", (db, org) => new GoalLinksService(db).getLinks(org, 1)],
    ["GET /hr/travel-visits/:travelRequestId", (db, org) => new HrTravelVisitsService(db).listVisits(org, 1, { limit: 50 })],
    [
      "GET /hr/enterprise/comp/planning/cycles/:cycleId/budget-pools",
      (db, org) =>
        new CompPlanningService(
          db,
          stub<ConstructorParameters<typeof CompPlanningService>[1]>(),
          stub<ConstructorParameters<typeof CompPlanningService>[2]>(),
        ).getBudgetPools(org, 1),
    ],
    [
      "GET /hr/automations/:ruleId/runs",
      (db, org) =>
        new HrAutomationEngineService(db, stub<ConstructorParameters<typeof HrAutomationEngineService>[1]>()).listRuns(
          org,
          { ruleId: 1, limit: 20 },
        ),
    ],
  ];

  it.each(cases)("%s refuses a parent the org does not own", async (_name, call) => {
    await expect(call(makeDb(undefined), ATTACKER_ORG)).rejects.toThrow(NotFoundException);
  });

  it.each(cases)("%s still runs for a parent the org owns (control)", async (_name, call) => {
    await expect(call(makeDb({ id: 1 }), OWNER_ORG)).resolves.toBeDefined();
  });
});
