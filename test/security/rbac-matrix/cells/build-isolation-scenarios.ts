import type { Table } from "drizzle-orm";
import type { ModuleRef } from "@nestjs/core";
import { projectRetentionSettings, projects, tickets } from "src/db/schema";
import { ClientPortalManagementService } from "src/modules/build/client-portal/client-portal-management.service";
import {
  BuildAutomationActionExecutor,
  type AutomationTicketChange,
  type StoredAction,
} from "src/modules/build/core/automation/build-automation-actions.service";
import type { ProjectsTicketLabelsService } from "src/modules/build/core/tickets/projects-ticket-labels.service";
import type { ProjectsTicketCommentsService } from "src/modules/build/core/tickets/projects-ticket-comments.service";
import { ProjectsRestoreService } from "src/modules/build/core/project-crud/projects-restore.service";
import { ProjectsRetentionSettingsService } from "src/modules/build/core/settings/projects-retention-settings.service";
import { ProjectsSettingsIterationsService } from "src/modules/build/core/settings/projects-settings-iterations.service";
import { ProjectsTicketsRestoreService } from "src/modules/build/core/tickets/projects-tickets-restore.service";
import { setLegalHoldSchema } from "src/modules/build/core/dto/project-retention-settings.schemas";
import { updateIterationSettingsSchema } from "src/modules/build/core/dto/iterations-settings.schemas";
import type { Observation, Scenario } from "../matrix.types";
import { audit, cache } from "../adapters/real-services";
import { tenantBound } from "../adapters/hr-adapter";
import { ORG_A, ORG_B, accessFor, actorFor, type Standing } from "../standings";
import { boundValues, standIn, type Row, type WorldDb } from "../world-db";
import { TENANT_ONLY, pair, standingWorld, victimOf } from "./isolation-kit";

const LIVE_PROJECT = 6101;
const DELETED_PROJECT = 6102;
const LIVE_TICKET = 6201;
const DELETED_TICKET = 6202;
const ORPHANED_TICKET = 6203;
const TICKET_VERSION = 3;
const RETENTION_ROW = 6301;
const DELETED_AT = new Date("2026-09-01T00:00:00Z");
const AUTOMATION_PATH = "src/modules/build/core/automation/build-automation-actions.service.ts";

function project(id: number, deletedAt: Date | null): Row {
  return {
    id,
    orgId: ORG_A,
    managerMembershipId: null,
    deletedAt,
    status: "ACTIVE",
    settings: null,
    portalPublishedAt: new Date("2026-08-01T00:00:00Z"),
    name: `Project ${id}`,
    key: `ISO${id}`,
    intakeToken: `intake-${id}`,
  };
}

function ticket(id: number, projectId: number, ticketNumber: number, deletedAt: Date | null): Row {
  return {
    id,
    orgId: ORG_A,
    projectId,
    deletedAt,
    assigneeMembershipId: null,
    reporterId: null,
    parentTicketId: null,
    version: TICKET_VERSION,
    ticketNumber,
    title: `Ticket ${id}`,
    status: "Todo",
  };
}

function buildRows(): Map<Table, Row[]> {
  return new Map<Table, Row[]>([
    [projects, [project(LIVE_PROJECT, null), project(DELETED_PROJECT, DELETED_AT)]],
    [
      tickets,
      [
        ticket(LIVE_TICKET, LIVE_PROJECT, 1, null),
        ticket(DELETED_TICKET, LIVE_PROJECT, 2, DELETED_AT),
        ticket(ORPHANED_TICKET, DELETED_PROJECT, 1, DELETED_AT),
      ],
    ],
    [projectRetentionSettings, [{ id: RETENTION_ROW, orgId: ORG_A, projectId: LIVE_PROJECT, version: 1 }]],
  ]);
}

function rowOf(world: WorldDb, table: Table, id: number): Row | undefined {
  return (world.rows.get(table) ?? []).find((row) => row.id === id);
}

function fieldOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

type Run = (callerOrg: string) => () => Promise<Observation>;

function servicePair(
  resource: string,
  action: string,
  id: string,
  entry: string,
  run: Run,
  because: { readonly allow: string; readonly deny: string },
  actor: Standing | "tenant-only" = "module:admin",
  covers: readonly string[] = [],
): Scenario[] {
  return pair(
    { actor, state: TENANT_ONLY.state, resource, action, covers },
    id,
    { because: because.allow, bindings: [{ adapter: "service", entry, run: run(ORG_A) }] },
    { because: because.deny, bindings: [{ adapter: "service", entry, run: run(ORG_B) }] },
  );
}

function portal(): Scenario[] {
  const run: Run = (callerOrg) => () => {
    const world = standingWorld(buildRows());
    const service = new ClientPortalManagementService(world.db, accessFor(world));
    return tenantBound(
      world,
      { callerOrg, victimOrg: victimOf(callerOrg), ids: [LIVE_PROJECT] },
      () => service.unpublishPortal(actorFor("module:admin", callerOrg), LIVE_PROJECT),
      { lookup: "projects", writes: { table: "projects", verb: "update" } },
      () => ({ foreignPortalStaysPublished: callerOrg === ORG_A || rowOf(world, projects, LIVE_PROJECT)?.portalPublishedAt !== null }),
    );
  };
  return servicePair("build:client-portal", "unpublish", "build-client-portal-unpublish", "ClientPortalManagementService.unpublishPortal(actor)", run, {
    allow: "the build module admin unpublishes the portal of a project its own organisation holds",
    deny: "the write-access check and the update both bind the caller's org, so another organisation's project is not found and its portal stays published",
  });
}

function iterations(): Scenario[] {
  const input = updateIterationSettingsSchema.parse({ namingPrefix: "Sprint" });
  const run: Run = (callerOrg) => () => {
    const world = standingWorld(buildRows());
    const service = new ProjectsSettingsIterationsService(world.db, accessFor(world));
    return tenantBound(
      world,
      { callerOrg, victimOrg: victimOf(callerOrg), ids: [LIVE_PROJECT] },
      () => service.updateSettings(actorFor("module:admin", callerOrg), LIVE_PROJECT, input),
      { lookup: "projects", writes: { table: "projects", verb: "update" } },
      (value) => ({ returnsTheNewPrefixOnlyWhenAllowed: value === undefined || fieldOf(value, "namingPrefix") === "Sprint" }),
    );
  };
  return servicePair("build:iteration-settings", "update", "build-iteration-settings-update", "ProjectsSettingsIterationsService.updateSettings(actor)", run, {
    allow: "the build module admin rewrites the iteration settings of its own organisation's project",
    deny: "management is resolved against the caller's org, so another organisation's project id answers 404 and its settings are never rewritten",
  });
}

function retention(): Scenario[] {
  const input = setLegalHoldSchema.parse({ active: true, reason: "litigation" });
  const run: Run = (callerOrg) => () => {
    const world = standingWorld(buildRows());
    const service = new ProjectsRetentionSettingsService(world.db, accessFor(world));
    const mark = world.writes.length;
    return tenantBound(
      world,
      { callerOrg, victimOrg: victimOf(callerOrg), ids: [LIVE_PROJECT] },
      () => service.setLegalHold(actorFor("module:admin", callerOrg), LIVE_PROJECT, input),
      { lookup: "projects" },
      () => {
        const writes = world.writes.slice(mark).filter((write) => write.table === "project_retention_settings");
        const held = rowOf(world, projectRetentionSettings, RETENTION_ROW)?.legalHold;
        return {
          holdWrittenOnlyWhenOwned: callerOrg === ORG_A ? writes.length === 1 && writes[0].verb === "update" && held === true : writes.length === 0,
          holdWriteBindsCallerOrg: writes.every((write) => boundValues(write.where).includes(callerOrg)),
        };
      },
    );
  };
  return servicePair("build:retention-settings", "legal-hold", "build-retention-legal-hold", "ProjectsRetentionSettingsService.setLegalHold(actor)", run, {
    allow: "the build module admin places a legal hold on its own organisation's project retention row",
    deny: "the project is resolved under the caller's org first, so another organisation's project answers 404 and no hold is written or inserted",
  });
}

function projectRestore(): Scenario[] {
  const run: Run = (callerOrg) => () => {
    const world = standingWorld(buildRows());
    const service = new ProjectsRestoreService(world.db, audit, cache, accessFor(world));
    return tenantBound(
      world,
      { callerOrg, victimOrg: victimOf(callerOrg), ids: [DELETED_PROJECT] },
      () => service.restoreProject(actorFor("org:owner", callerOrg), DELETED_PROJECT),
      { lookup: "projects", writes: { table: "projects", verb: "update" } },
      (value) => ({
        restoresTheChildTicketOnlyWhenAllowed:
          value === undefined
            ? rowOf(world, tickets, ORPHANED_TICKET)?.deletedAt === DELETED_AT
            : fieldOf(value, "restoredChildren") === 1 && rowOf(world, tickets, ORPHANED_TICKET)?.deletedAt === null,
        foreignProjectStaysDeleted: callerOrg === ORG_A || rowOf(world, projects, DELETED_PROJECT)?.deletedAt === DELETED_AT,
      }),
    );
  };
  return servicePair(
    "build:project",
    "restore",
    "build-project-restore",
    "ProjectsRestoreService.restoreProject(actor)",
    run,
    {
      allow: "the org owner restores its own deleted project together with the ticket deleted in the same cascade",
      deny: "the deleted project is looked up under the caller's org, so another organisation's project answers 404 and neither it nor its tickets come back",
    },
    "org:owner",
  );
}

function ticketRestore(): Scenario[] {
  const run: Run = (callerOrg) => () => {
    const world = standingWorld(buildRows());
    const service = new ProjectsTicketsRestoreService(world.db, audit, accessFor(world), cache);
    return tenantBound(
      world,
      { callerOrg, victimOrg: victimOf(callerOrg), ids: [DELETED_TICKET] },
      () => service.restoreTicket(actorFor("module:admin", callerOrg), LIVE_PROJECT, DELETED_TICKET),
      { lookup: "tickets", writes: { table: "tickets", verb: "update" } },
      () => ({ foreignTicketStaysDeleted: callerOrg === ORG_A || rowOf(world, tickets, DELETED_TICKET)?.deletedAt === DELETED_AT }),
    );
  };
  return servicePair("build:ticket", "restore", "build-ticket-restore", "ProjectsTicketsRestoreService.restoreTicket(actor)", run, {
    allow: "the build module admin restores a deleted ticket of its own organisation's project",
    deny: "the ticket write decision binds the caller's org, so another organisation's deleted ticket answers 404 and stays deleted",
  });
}

function automation(): Scenario[] {
  const action: StoredAction = { type: "set_status", value: "Done" };
  const run: Run = (callerOrg) => () => {
    const world = standingWorld(buildRows());
    const changes: Array<{ readonly orgId: string; readonly ticketId: number; readonly version: unknown }> = [];
    const change: AutomationTicketChange = {
      updateTicket: async (actor, _projectId, ticketId, input) => {
        changes.push({ orgId: actor.orgId, ticketId, version: input.version });
        return undefined;
      },
    };
    const executor = new BuildAutomationActionExecutor(
      world.db,
      standIn<ModuleRef>({ get: () => change }),
      standIn<ProjectsTicketLabelsService>({}),
      standIn<ProjectsTicketCommentsService>({}),
    );
    return tenantBound(
      world,
      { callerOrg, victimOrg: victimOf(callerOrg), ids: [LIVE_TICKET] },
      () => executor.execute(callerOrg, LIVE_PROJECT, LIVE_TICKET, action, null),
      { lookup: "tickets", sites: 1 },
      () => ({
        ticketChangedOnlyWhenOwned:
          callerOrg === ORG_A
            ? changes.length === 1 && changes[0].orgId === ORG_A && changes[0].version === TICKET_VERSION
            : changes.length === 0,
      }),
    );
  };
  return servicePair(
    "build:automation-action",
    "execute",
    "build-automation-action-execute",
    `BuildAutomationActionExecutor.execute(orgId) in ${AUTOMATION_PATH}`,
    run,
    {
      allow: "a rule firing in the ticket's own organisation reads the ticket's version and hands the change to the ticket writer",
      deny: "the ticket is resolved under the rule's org, so a rule in another organisation naming this ticket id answers 404 and the ticket writer is never called",
    },
    "tenant-only",
  );
}

export function buildIsolationScenarios(): Scenario[] {
  return [...portal(), ...iterations(), ...retention(), ...projectRestore(), ...ticketRestore(), ...automation()];
}
