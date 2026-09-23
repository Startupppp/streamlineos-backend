import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import {
  HrHelpdeskEscalationService,
  type EscalationAdminsReader,
} from "./hr-helpdesk-escalation.service";
import type { EffectiveQueueConfig } from "./hr-helpdesk-config.service";
import type { HrHelpdeskConfigService } from "./hr-helpdesk-config.service";
import type { AccessService } from "../../access/access.service";
import type { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { HrAuditService } from "../core/hr-audit.service";
import { SUPPORT_QUEUES, type SupportQueue } from "./lib/support-queues";

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const NOW = new Date("2024-01-15T12:00:00Z");
const dialect = new PgDialect();

function defaultQueueConfigs(): Record<SupportQueue, EffectiveQueueConfig> {
  const entry = (queue: SupportQueue): EffectiveQueueConfig => ({
    queue,
    source: "default",
    firstResponseHours: 8,
    resolutionHours: 72,
    escalationUserId: null,
    escalationMembershipId: null,
  });
  return Object.fromEntries(SUPPORT_QUEUES.map((q) => [q, entry(q)])) as Record<
    SupportQueue,
    EffectiveQueueConfig
  >;
}

function makeConfig(): HrHelpdeskConfigService {
  return {
    queueConfigs: jest.fn().mockResolvedValue(defaultQueueConfigs()),
  } as unknown as HrHelpdeskConfigService;
}

function makeAdmins(): EscalationAdminsReader {
  return { membersWithPermission: jest.fn().mockResolvedValue([]) };
}

function makeDispatch(): NotificationDispatchService {
  return { emit: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationDispatchService;
}

function makeAudit(): HrAuditService {
  return { log: jest.fn().mockResolvedValue(undefined) } as unknown as HrAuditService;
}

function makeSvc(): HrHelpdeskEscalationService {
  return new HrHelpdeskEscalationService(
    {} as Db,
    makeConfig(),
    {} as AccessService,
    makeDispatch(),
    makeAudit(),
  );
}

function makeTx(ticketRows: unknown[]) {
  let capturedWhere: SQL | undefined;

  const selectChain: Record<string, unknown> = {};
  Object.assign(selectChain, {
    from: jest.fn().mockReturnValue(selectChain),
    where: jest.fn().mockImplementation((cond: SQL) => {
      capturedWhere = cond;
      return selectChain;
    }),
    orderBy: jest.fn().mockReturnValue(selectChain),
    limit: jest.fn().mockResolvedValue(ticketRows),
  });

  const returningMock = jest.fn().mockResolvedValue([{ id: 1 }]);
  const updateWhereMock = jest.fn().mockReturnValue({ returning: returningMock });
  const setMock = jest.fn().mockReturnValue({ where: updateWhereMock });

  const tx = {
    select: jest.fn().mockReturnValue(selectChain),
    update: jest.fn().mockReturnValue({ set: setMock }),
  } as unknown as DbOrTx;

  return { tx, getCapturedWhere: () => capturedWhere };
}

function overdueTicketRow() {
  return {
    id: 1,
    title: "Payroll issue",
    queue: "HR" as SupportQueue,
    userId: "user-req-1",
    assigneeId: null,
    firstResponseDueAt: new Date(0),
    firstRespondedAt: null,
    slaDueAt: new Date(0),
  };
}

describe("HrHelpdeskEscalationService — tenant isolation", () => {
  describe("sweepOrg SELECT predicate is caller-org-scoped (cross-tenant isolation)", () => {
    it("binds the owner org to the ticket SELECT WHERE clause and never the foreign org (org-scoping predicate reaches the db layer)", async () => {
      const { tx, getCapturedWhere } = makeTx([]);
      const svc = makeSvc();

      await svc.sweepOrg(tx, OWNER_ORG, NOW, makeAdmins());

      const captured = getCapturedWhere();
      expect(captured).toBeDefined();
      const rendered = dialect.sqlToQuery(captured!);
      expect(rendered.params).toContain(OWNER_ORG);
      expect(rendered.params).not.toContain(ATTACKER_ORG);
    });

    it("binds the attacker org to the predicate when called with that org, keeping the owner org absent (cross-tenant isolation: predicate follows the caller, not a fixed anchor)", async () => {
      const { tx, getCapturedWhere } = makeTx([]);
      const svc = makeSvc();

      await svc.sweepOrg(tx, ATTACKER_ORG, NOW, makeAdmins());

      const captured = getCapturedWhere();
      expect(captured).toBeDefined();
      const rendered = dialect.sqlToQuery(captured!);
      expect(rendered.params).toContain(ATTACKER_ORG);
      expect(rendered.params).not.toContain(OWNER_ORG);
    });
  });

  describe("sweepOrg positive behavior control", () => {
    it("escalates an overdue ticket when swept under the owning org (same-org control proving the escalation path is reachable)", async () => {
      const { tx } = makeTx([overdueTicketRow()]);
      const svc = new HrHelpdeskEscalationService(
        {} as Db,
        makeConfig(),
        {} as AccessService,
        makeDispatch(),
        makeAudit(),
      );

      const result = await svc.sweepOrg(tx, OWNER_ORG, NOW, makeAdmins());

      expect(result.escalated).toBe(1);
    });

    it("returns zero escalations when swept under a different org with no matching tickets (cross-tenant isolation: the predicate prevents access to another org's rows)", async () => {
      const { tx } = makeTx([]);
      const svc = makeSvc();

      const result = await svc.sweepOrg(tx, ATTACKER_ORG, NOW, makeAdmins());

      expect(result.escalated).toBe(0);
    });
  });
});
