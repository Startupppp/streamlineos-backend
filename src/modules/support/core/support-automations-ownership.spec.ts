import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AutomationActionExecutor } from "../../automation/automation-action-executor.service";
import { AutomationService } from "../../automation/automation.service";
import type { AutomationAction } from "../../automation/dto/automation.schemas";
import { AutomationEmailService } from "../../automation/automation-email.service";
import { AutomationWebhookService } from "../../automation/automation-webhook.service";
import { AiNodeExecutorService } from "../../automation/ai-workflow-nodes/ai-node-executor.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { SupportAutomationsController } from "./support-automations.controller";
import { SupportSettingsAuditService } from "./support-settings-audit.service";

const USER: CurrentUserContext = {
  orgId: "org-support",
  userId: "support-admin",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "support-session",
  tokenScopes: null,
  principal: humanSessionPrincipal(10, false),
};
const RULES = [
  { id: 7, orgId: USER.orgId, triggerEvent: "invoice.paid", conditions: [], actions: [] },
  { id: 8, orgId: USER.orgId, triggerEvent: "ticket.created", conditions: [], actions: [] },
  { id: 9, orgId: "another-org", triggerEvent: "ticket.created", conditions: [], actions: [] },
];
const RUNS = RULES.map((rule) => ({ ...rule, ruleId: rule.id, id: rule.id + 100 }));

function matchesPredicate(where: SQL, row: Pick<(typeof RULES)[number], "id" | "orgId" | "triggerEvent"> & { ruleId?: number }) {
  const query = new PgDialect().sqlToQuery(where);
  const parameter = (column: string) => {
    const match = query.sql.match(new RegExp(`"${column}" = \\$(\\d+)`));
    return match ? query.params[Number(match[1]) - 1] : undefined;
  };
  const prefixMatch = query.sql.match(/"trigger_event" like \$(\d+)/);
  const pattern = prefixMatch ? query.params[Number(prefixMatch[1]) - 1] : undefined;
  return parameter("org_id") === row.orgId
    && (parameter("id") === undefined || parameter("id") === row.id)
    && (parameter("rule_id") === undefined || parameter("rule_id") === row.ruleId)
    && (pattern === undefined || (typeof pattern === "string" && row.triggerEvent.startsWith(pattern.slice(0, -1))));
}

async function harness(actions: AutomationAction[] = []) {
  const predicates: SQL[] = [];
  const selectRules = (where: SQL) => {
    predicates.push(where);
    return RULES.map((row) => ({ ...row, actions: row.id === 8 ? actions : row.actions }))
      .filter((row) => matchesPredicate(where, row));
  };
  const writeWhere = jest.fn((where: SQL) => ({ returning: jest.fn().mockResolvedValue(selectRules(where)) }));
  const set = jest.fn().mockReturnValue({ where: writeWhere });
  const db = {
    query: {
      supportTickets: {
        findFirst: jest.fn(({ where }: { where: SQL }) => Promise.resolve(
          [{ id: 42, orgId: USER.orgId }, { id: 43, orgId: "another-org" }]
            .find((ticket) => matchesPredicate(where, { ...ticket, triggerEvent: "" })),
        )),
      },
      automationRules: {
        findFirst: jest.fn(({ where }: { where: SQL }) => Promise.resolve(selectRules(where)[0])),
        findMany: jest.fn(({ where }: { where: SQL }) => Promise.resolve(selectRules(where))),
      },
      automationRuns: {
        findMany: jest.fn(({ where }: { where: SQL }) => {
          predicates.push(where);
          return Promise.resolve(RUNS.filter((row) => matchesPredicate(where, row)));
        }),
      },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn((where: SQL) => Promise.resolve([{ total: selectRules(where).length }])),
      }),
    }),
    update: jest.fn().mockReturnValue({ set }),
    delete: jest.fn().mockReturnValue({ where: writeWhere }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 100 }]) }),
    }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const module = await Test.createTestingModule({
    providers: [
      AutomationService,
      AutomationActionExecutor,
      { provide: DRIZZLE, useValue: db },
      { provide: SupportSettingsAuditService, useValue: audit },
      { provide: NotificationsService, useValue: { create: jest.fn() } },
      { provide: AutomationEmailService, useValue: { send: jest.fn() } },
      { provide: AutomationWebhookService, useValue: { dispatchWebhook: jest.fn() } },
      { provide: PlanLimitsService, useValue: { assertWithinLimit: jest.fn() } },
      { provide: AiNodeExecutorService, useValue: { executeNode: jest.fn() } },
    ],
  }).compile();
  return {
    controller: new SupportAutomationsController(module.get(AutomationService), module.get(SupportSettingsAuditService)),
    service: module.get(AutomationService),
    db,
    audit,
    set,
    predicates,
  };
}

function expectSupportPredicates(predicates: SQL[]) {
  expect(predicates.length).toBeGreaterThan(0);
  for (const predicate of predicates) {
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.sql).toMatch(/"org_id" = \$\d+/);
    expect(query.sql).toMatch(/"trigger_event" like \$\d+/);
    expect(query.params).toContain(USER.orgId);
    expect(query.params).toContain("ticket.%");
  }
}

describe("Support automations — controller/service ownership boundary", () => {
  it("lists only ticket rules from the caller's organization", async () => {
    const { controller, predicates } = await harness();
    const result = await controller.listAutomations({ page: 1, limit: 20 }, USER);
    expect(result.data.map((rule) => rule.id)).toEqual([8]);
    expect(result.pagination.total).toBe(1);
    expectSupportPredicates(predicates);
  });

  it.each([undefined, "7", "8", "9"])("filters run history with automationId=%s", async (ruleId) => {
    const { controller, predicates } = await harness();
    const runs = await controller.listAutomationRuns(ruleId, USER);
    expect(runs.map((run) => run.ruleId)).toEqual(ruleId === undefined || ruleId === "8" ? [8] : []);
    expectSupportPredicates(predicates);
  });

  it.each([7, 9])("cannot update rule %i outside Support ownership", async (ruleId) => {
    const { controller, audit, predicates } = await harness();
    await expect(controller.updateAutomation(ruleId, { name: "changed" }, USER)).rejects.toThrow(NotFoundException);
    expect(audit.record).not.toHaveBeenCalled();
    expectSupportPredicates(predicates);
  });

  it.each([7, 9])("cannot delete rule %i outside Support ownership", async (ruleId) => {
    const { controller, audit, predicates } = await harness();
    await expect(controller.deleteAutomation(ruleId, USER)).rejects.toThrow(NotFoundException);
    expect(audit.record).not.toHaveBeenCalled();
    expectSupportPredicates(predicates);
  });

  it.each([7, 9])("cannot execute rule %i outside Support ownership", async (ruleId) => {
    const { controller, service, db, predicates } = await harness();
    const execute = jest.spyOn(service, "runRule");
    await expect(controller.testAutomation(ruleId, { payload: {} }, USER)).rejects.toThrow(NotFoundException);
    expect(execute).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expectSupportPredicates(predicates);
  });

  it("cannot change a Support trigger to another module", async () => {
    const { controller, db, audit } = await harness();
    await expect(controller.updateAutomation(8, { triggerEvent: "invoice.paid" }, USER)).rejects.toThrow(NotFoundException);
    expect(db.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("cannot take over another module's rule by changing its trigger to ticket.*", async () => {
    const { controller, predicates } = await harness();
    await expect(controller.updateAutomation(7, { triggerEvent: "ticket.priority_changed" }, USER)).rejects.toThrow(NotFoundException);
    expectSupportPredicates(predicates);
  });

  it("preserves legitimate Support update, delete and test operations", async () => {
    const { controller, audit, set, predicates } = await harness();
    await expect(controller.updateAutomation(8, { triggerEvent: "ticket.priority_changed" }, USER)).resolves.toMatchObject({ id: 8 });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ triggerEvent: "ticket.priority_changed" }));
    await expect(controller.testAutomation(8, { payload: {} }, USER)).resolves.toMatchObject({ matched: true, status: "success" });
    await expect(controller.deleteAutomation(8, USER)).resolves.toEqual({ success: true });
    expect(audit.record).toHaveBeenCalledTimes(2);
    expectSupportPredicates(predicates);
  });

  it("preserves general automation access within the tenant", async () => {
    const { service, predicates } = await harness();
    await expect(service.updateRule(USER.orgId, 7, { name: "invoice rule" })).resolves.toMatchObject({ id: 7 });
    await expect(service.testRule(USER.orgId, 7, {})).resolves.toMatchObject({ status: "success" });
    await expect(service.deleteRule(USER.orgId, 7)).resolves.toEqual({ success: true });
    const runs = await service.listRuns(USER.orgId);
    expect(runs.map((run) => run.ruleId)).toEqual([7, 8]);
    for (const predicate of predicates) {
      const query = new PgDialect().sqlToQuery(predicate);
      expect(query.params).toContain(USER.orgId);
      expect(query.params).not.toContain("ticket.%");
    }
  });

  it.each([undefined, 0, -1, 1.5, 43, 404])("does not execute Support actions on invalid or unavailable ticket %s", async (ticketId) => {
    const { controller, service, db } = await harness([{ type: "support_set_priority", config: { priority: "URGENT" } }]);
    const execute = jest.spyOn(service, "runRule");
    await expect(controller.testAutomation(8, { payload: { ticketId } }, USER)).rejects.toThrow(NotFoundException);
    expect(execute).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("executes Support actions only after resolving the supplied ticket within the tenant", async () => {
    const { controller, db } = await harness([{ type: "support_set_priority", config: { priority: "URGENT" } }]);
    await expect(controller.testAutomation(8, { payload: { ticketId: 42 } }, USER)).resolves.toMatchObject({ status: "success" });
    expect(db.query.supportTickets.findFirst).toHaveBeenCalledTimes(1);
    const query = new PgDialect().sqlToQuery(db.query.supportTickets.findFirst.mock.calls[0][0].where);
    expect(query.sql).toMatch(/"support_tickets"\."org_id" = \$\d+/);
    expect(query.sql).toMatch(/"support_tickets"\."id" = \$\d+/);
    expect(query.params).toEqual(expect.arrayContaining([USER.orgId, 42]));
  });
});
