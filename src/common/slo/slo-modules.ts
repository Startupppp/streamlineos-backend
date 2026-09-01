import { ALERT_RUNBOOK, type ServiceLevelObjective, type SloOwner } from "./slo-types";

const READ_ALERT = "seam-latency";
const WRITE_ALERT = "seam-latency";
const RUNBOOK_ANCHOR = "#seam-latency";

interface ModuleOwnership {
  readonly module: string;
  readonly owner: SloOwner;
  readonly readSurface: string;
  readonly writeSurface: string;
}

export const MODULE_SLO_OWNERSHIP: readonly ModuleOwnership[] = [
  {
    module: "hr",
    owner: "people-team",
    readSurface: "employee, leave, attendance and recruitment lists",
    writeSurface: "employment, leave and onboarding mutations",
  },
  {
    module: "payroll",
    owner: "people-team",
    readSurface: "run, payslip and component lists",
    writeSurface: "run posting and payslip release",
  },
  {
    module: "timesheets",
    owner: "people-team",
    readSurface: "timesheet and approval lists",
    writeSurface: "timesheet submission and approval",
  },
  {
    module: "directory",
    owner: "people-team",
    readSurface: "people directory and worker lookups",
    writeSurface: "person, worker and engagement mutations",
  },
  {
    module: "build",
    owner: "delivery-team",
    readSurface: "board, backlog, ticket and sprint lists",
    writeSurface: "ticket, sprint and QA mutations",
  },
  {
    module: "workflows",
    owner: "delivery-team",
    readSurface: "workflow definition and run lists",
    writeSurface: "workflow definition and manual-run mutations",
  },
  {
    module: "sign",
    owner: "delivery-team",
    readSurface: "envelope and recipient lists",
    writeSurface: "envelope send, sign and void",
  },
  {
    module: "surveys",
    owner: "delivery-team",
    readSurface: "survey and response lists",
    writeSurface: "survey publish and response submission",
  },
  {
    module: "feedbucket",
    owner: "support-team",
    readSurface: "feedback item lists",
    writeSurface: "feedback capture and triage",
  },
  {
    module: "support",
    owner: "support-team",
    readSurface: "ticket, queue and SLA lists",
    writeSurface: "ticket create, assign and resolve",
  },
  {
    module: "accounting",
    owner: "finance-team",
    readSurface: "ledger, invoice and report lists",
    writeSurface: "journal posting and invoice issue",
  },
  {
    module: "billing",
    owner: "payments-team",
    readSurface: "plan, invoice, seat and AI-credit reads",
    writeSurface: "checkout, verification and credit settlement",
  },
  {
    module: "kb",
    owner: "knowledge-team",
    readSurface: "space, page and retrieval reads",
    writeSurface: "page authoring, publish and reindex",
  },
  {
    module: "blog",
    owner: "knowledge-team",
    readSurface: "public post reads",
    writeSurface: "post authoring and publish",
  },
  {
    module: "chat",
    owner: "communications-team",
    readSurface: "conversation and message history reads",
    writeSurface: "message send and reaction",
  },
  {
    module: "mail",
    owner: "communications-team",
    readSurface: "mailbox and thread reads",
    writeSurface: "send, reply and label mutations",
  },
  {
    module: "calendar",
    owner: "communications-team",
    readSurface: "aggregated calendar source reads",
    writeSurface: "event, recurrence and attendee mutations",
  },
  {
    module: "home",
    owner: "communications-team",
    readSurface: "dashboard, For Me and announcement reads",
    writeSurface: "self-service actions surfaced on Home",
  },
  {
    module: "notifications",
    owner: "notifications-team",
    readSurface: "inbox, unread-count and cursor reads",
    writeSurface: "read, dismiss and preference mutations",
  },
  {
    module: "settings",
    owner: "platform-reliability",
    readSurface: "organization, hierarchy and access-governance reads",
    writeSurface: "organization, role and module-enablement mutations",
  },
];

function readObjective(entry: ModuleOwnership): ServiceLevelObjective {
  return {
    id: `module:${entry.module}:read`,
    kind: "module",
    subject: entry.module,
    statement: `p95 of ${entry.readSurface} stays within the route.cached.read budget.`,
    indicator: { kind: "seam", seam: "route.cached.read", percentile: "p95" },
    owner: entry.owner,
    alertId: READ_ALERT,
    runbookFile: ALERT_RUNBOOK,
    runbookAnchor: RUNBOOK_ANCHOR,
  };
}

function writeObjective(entry: ModuleOwnership): ServiceLevelObjective {
  return {
    id: `module:${entry.module}:write`,
    kind: "module",
    subject: entry.module,
    statement: `p95 of ${entry.writeSurface} stays within the route.write budget, excluding declared async work.`,
    indicator: { kind: "seam", seam: "route.write", percentile: "p95" },
    owner: entry.owner,
    alertId: WRITE_ALERT,
    runbookFile: ALERT_RUNBOOK,
    runbookAnchor: RUNBOOK_ANCHOR,
  };
}

export const MODULE_SLOS: readonly ServiceLevelObjective[] =
  MODULE_SLO_OWNERSHIP.flatMap((entry) => [readObjective(entry), writeObjective(entry)]);

const OWNER_BY_MODULE = new Map<string, SloOwner>(
  MODULE_SLO_OWNERSHIP.map((entry) => [entry.module, entry.owner]),
);

export function ownerForModule(moduleId: string): SloOwner | undefined {
  return OWNER_BY_MODULE.get(moduleId);
}
