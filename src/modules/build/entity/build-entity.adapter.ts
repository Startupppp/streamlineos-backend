import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  projectIncidents,
  projectReleases,
  projects,
  sprints,
  tickets,
} from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import {
  unresolved,
  type EntityAction,
  type EntityActionResult,
  type EntityActor,
  type EntityAdapter,
  type EntityCard,
  type EntityReference,
  type EntityResolution,
} from "../../entity-reference/entity-reference.types";
import { BuildEntityActions } from "./build-entity.actions";

type Permissions = Map<string, DataScope>;

interface AccessPort {
  resolveUserPermissions(orgId: string, userId: string): Promise<Permissions>;
}

/**
 * `task` is the name entity-linked channels were stored under before message
 * references settled on `ticket`. Both resolve tickets so existing channel rows
 * keep working; `ticket` is the canonical name for anything new.
 */
const TICKET_TYPES = ["ticket", "task"] as const;

const READ_KEY: Record<string, string> = {
  ticket: "build:tickets:view",
  task: "build:tickets:view",
  project: "build:view",
  sprint: "build:sprints:view",
  release: "build:view",
  incident: "build:incidents:view",
};

function isTicketType(type: string): boolean {
  return (TICKET_TYPES as readonly string[]).includes(type);
}

const TICKET_ACTIONS: ReadonlyArray<{
  id: string;
  label: string;
  key: string;
  inputs: EntityAction["inputs"];
}> = [
  {
    id: "status",
    label: "Change status",
    key: "build:tickets:update",
    inputs: [{ name: "status", kind: "choice", required: true }],
  },
  {
    id: "assign",
    label: "Assign",
    key: "build:tickets:assign",
    inputs: [{ name: "assigneeId", kind: "user", required: true }],
  },
  {
    id: "due-date",
    label: "Set due date",
    key: "build:tickets:update",
    inputs: [{ name: "dueDate", kind: "date", required: true }],
  },
];

const PROJECT_ACTIONS: ReadonlyArray<{
  id: string;
  label: string;
  key: string;
  inputs: EntityAction["inputs"];
}> = [
  {
    id: "create-ticket",
    label: "Create ticket",
    key: "build:tickets:create",
    inputs: [
      { name: "title", kind: "text", required: false },
      { name: "type", kind: "choice", required: true, choices: ["TASK", "BUG"] },
    ],
  },
];

function numericId(reference: EntityReference): number | null {
  const parsed = Number(reference.id);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

@Injectable()
export class BuildEntityAdapter implements EntityAdapter {
  readonly moduleKey = "build";
  readonly types = [
    "ticket",
    "task",
    "project",
    "sprint",
    "release",
    "incident",
  ] as const;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(AccessService) private readonly access: AccessPort,
    private readonly actions: BuildEntityActions,
  ) {}

  async resolve(
    actor: EntityActor,
    references: EntityReference[],
  ): Promise<EntityResolution[]> {
    const permissions = await this.access.resolveUserPermissions(
      actor.orgId,
      actor.userId,
    );
    return this.resolveWith(actor, references, permissions);
  }

  async actionsFor(
    actor: EntityActor,
    references: EntityReference[],
  ): Promise<EntityAction[][]> {
    const permissions = await this.access.resolveUserPermissions(
      actor.orgId,
      actor.userId,
    );
    const resolutions = await this.resolveWith(actor, references, permissions);

    return references.map((reference, index) => {
      if (resolutions[index]?.status !== "resolved") return [];
      const catalog = isTicketType(reference.type)
        ? TICKET_ACTIONS
        : reference.type === "project"
          ? PROJECT_ACTIONS
          : [];
      return catalog
        .filter((action) => this.holds(actor, permissions, action.key))
        .map((action) => ({
          id: action.id,
          label: action.label,
          inputs: action.inputs,
        }));
    });
  }

  async submitAction(
    actor: EntityActor,
    reference: EntityReference,
    actionId: string,
    input: Record<string, unknown>,
  ): Promise<EntityActionResult> {
    const permissions = await this.access.resolveUserPermissions(
      actor.orgId,
      actor.userId,
    );
    const catalog = isTicketType(reference.type)
      ? TICKET_ACTIONS
      : reference.type === "project"
        ? PROJECT_ACTIONS
        : [];
    const action = catalog.find((candidate) => candidate.id === actionId);
    if (!action) return { ok: false, reason: "invalid" };
    if (!this.holds(actor, permissions, action.key))
      return { ok: false, reason: "forbidden" };

    return this.actions.run(actor, reference, actionId, input);
  }

  private holds(
    actor: EntityActor,
    permissions: Permissions,
    key: string,
  ): boolean {
    if (actor.isOrgOwner) return true;
    const scope = permissions.get(key);
    return scope !== undefined && scope !== "none";
  }

  private async resolveWith(
    actor: EntityActor,
    references: EntityReference[],
    permissions: Permissions,
  ): Promise<EntityResolution[]> {
    const results = references.map(unresolved);
    const wanted = new Map<string, { id: number; index: number }[]>();

    references.forEach((reference, index) => {
      const readKey = READ_KEY[reference.type];
      if (!readKey) return;
      if (!this.holds(actor, permissions, readKey)) return;
      const id = numericId(reference);
      if (id === null) return;
      const batch = wanted.get(reference.type) ?? [];
      batch.push({ id, index });
      wanted.set(reference.type, batch);
    });

    await Promise.all(
      [...wanted].map(async ([type, batch]) => {
        const cards = await this.readCards(
          actor.orgId,
          type,
          batch.map((entry) => entry.id),
        );
        for (const entry of batch) {
          const card = cards.get(entry.id);
          if (card) results[entry.index] = { status: "resolved", card };
        }
      }),
    );

    return results;
  }

  private async readCards(
    orgId: string,
    type: string,
    ids: number[],
  ): Promise<Map<number, EntityCard>> {
    if (isTicketType(type)) return this.readTickets(orgId, type, ids);
    switch (type) {
      case "project":
        return this.readProjects(orgId, ids);
      case "sprint":
        return this.readSprints(orgId, ids);
      case "release":
        return this.readReleases(orgId, ids);
      case "incident":
        return this.readIncidents(orgId, ids);
      default:
        return new Map();
    }
  }

  private async readTickets(orgId: string, type: string, ids: number[]) {
    const rows = await this.db
      .select({
        id: tickets.id,
        title: tickets.title,
        status: tickets.status,
        ticketNumber: tickets.ticketNumber,
        projectKey: projects.key,
      })
      .from(tickets)
      .innerJoin(projects, eq(tickets.projectId, projects.id))
      .where(
        and(
          eq(tickets.orgId, orgId),
          inArray(tickets.id, ids),
          isNull(tickets.deletedAt),
        ),
      )
      .limit(ids.length);

    return this.index(rows, (row) => ({
      type,
      id: String(row.id),
      title: row.title,
      subtitle: `${row.projectKey}-${row.ticketNumber}`,
      status: row.status,
      href: `/build/tickets/${row.id}`,
    }));
  }

  private async readProjects(orgId: string, ids: number[]) {
    const rows = await this.db
      .select({
        id: projects.id,
        name: projects.name,
        key: projects.key,
        status: projects.status,
      })
      .from(projects)
      .where(
        and(
          eq(projects.orgId, orgId),
          inArray(projects.id, ids),
          isNull(projects.deletedAt),
        ),
      )
      .limit(ids.length);

    return this.index(rows, (row) => ({
      type: "project",
      id: String(row.id),
      title: row.name,
      subtitle: row.key,
      status: row.status,
      href: `/build/projects/${row.id}`,
    }));
  }

  private async readSprints(orgId: string, ids: number[]) {
    const rows = await this.db
      .select({
        id: sprints.id,
        name: sprints.name,
        status: sprints.status,
        projectId: sprints.projectId,
      })
      .from(sprints)
      .where(
        and(
          eq(sprints.orgId, orgId),
          inArray(sprints.id, ids),
          isNull(sprints.deletedAt),
        ),
      )
      .limit(ids.length);

    return this.index(rows, (row) => ({
      type: "sprint",
      id: String(row.id),
      title: row.name,
      subtitle: null,
      status: row.status,
      href: `/build/projects/${row.projectId}/sprints`,
    }));
  }

  private async readReleases(orgId: string, ids: number[]) {
    const rows = await this.db
      .select({
        id: projectReleases.id,
        name: projectReleases.name,
        version: projectReleases.version,
        status: projectReleases.status,
        projectId: projectReleases.projectId,
      })
      .from(projectReleases)
      .where(
        and(
          eq(projectReleases.orgId, orgId),
          inArray(projectReleases.id, ids),
          isNull(projectReleases.deletedAt),
        ),
      )
      .limit(ids.length);

    return this.index(rows, (row) => ({
      type: "release",
      id: String(row.id),
      title: row.name,
      subtitle: row.version,
      status: row.status,
      href: `/build/projects/${row.projectId}/releases`,
    }));
  }

  private async readIncidents(orgId: string, ids: number[]) {
    const rows = await this.db
      .select({
        id: projectIncidents.id,
        title: projectIncidents.title,
        incidentNumber: projectIncidents.incidentNumber,
        status: projectIncidents.status,
        severity: projectIncidents.severity,
      })
      .from(projectIncidents)
      .where(
        and(
          eq(projectIncidents.orgId, orgId),
          inArray(projectIncidents.id, ids),
          isNull(projectIncidents.deletedAt),
        ),
      )
      .limit(ids.length);

    return this.index(rows, (row) => ({
      type: "incident",
      id: String(row.id),
      title: row.title,
      subtitle: `#${row.incidentNumber} · ${row.severity}`,
      status: row.status,
      href: `/build/incidents/${row.id}`,
    }));
  }

  private index<T extends { id: number }>(
    rows: T[],
    toCard: (row: T) => EntityCard,
  ): Map<number, EntityCard> {
    const byId = new Map<number, EntityCard>();
    for (const row of rows) byId.set(row.id, toCard(row));
    return byId;
  }
}
