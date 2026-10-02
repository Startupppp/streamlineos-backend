import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";
import {
  projectIncidents,
  organizationMembers,
  projectMembers,
  projectReleases,
  projects,
  cycles,
  tickets,
  users,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import type { ScopedRead } from "../../access/scoped-read";
import { resolveEntityCardScope } from "./build-entity-scope";
import { entityProjectReach } from "./build-entity-action-helpers";
import { ticketVisibleSql } from "../core";
import { type Permissions } from "../../entity-reference/entity-scope";
import {
  unresolved,
  type EntityActor,
  type EntityCard,
  type EntityOption,
  type EntityReference,
  type EntityResolution,
} from "../../entity-reference/entity-reference.types";
import {
  buildCycleListHref,
  buildIncidentHref,
  buildProjectHref,
  buildReleaseListHref,
  buildTicketHref,
  buildTicketKey,
} from "../core";

const READ_KEY: Record<string, string> = {
  ticket: "build:tickets:view",
  task: "build:tickets:view",
  project: "build:view",
  cycle: "build:cycles:view",
  release: "build:view",
  incident: "build:incidents:view",
};

const TICKET_TYPES = ["ticket", "task"] as const;

export function isTicketType(type: string): boolean {
  return TICKET_TYPES.some((ticketType) => ticketType === type);
}

export function numericId(reference: EntityReference): number | null {
  const parsed = Number(reference.id);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export class BuildEntityReadsService {
  constructor(private readonly db: Db) {}

  async resolveWith(
    actor: EntityActor,
    references: EntityReference[],
    permissions: Permissions,
  ): Promise<EntityResolution[]> {
    const results = references.map(unresolved);
    const reach = entityProjectReach(actor, permissions);
    const wanted = new Map<
      string,
      { scope: ScopedRead; entries: { id: number; index: number }[] }
    >();

    references.forEach((reference, index) => {
      const readKey = READ_KEY[reference.type];
      if (!readKey) return;
      const scope = resolveEntityCardScope(actor, permissions, readKey);
      if (scope.denied) return;
      const id = numericId(reference);
      if (id === null) return;
      const batch = wanted.get(reference.type) ?? { scope, entries: [] };
      batch.entries.push({ id, index });
      wanted.set(reference.type, batch);
    });

    await Promise.all(
      [...wanted].map(async ([type, batch]) => {
        const cards = await this.readCards(
          actor,
          type,
          batch.entries.map((entry) => entry.id),
          batch.scope,
          reach,
        );
        for (const entry of batch.entries) {
          const card = cards.get(entry.id);
          if (card) results[entry.index] = { status: "resolved", card };
        }
      }),
    );

    return results;
  }

  async readCards(
    actor: EntityActor,
    type: string,
    ids: number[],
    scope: ScopedRead,
    reach: SQL,
  ): Promise<Map<number, EntityCard>> {
    if (isTicketType(type)) return this.readTickets(type, ids, scope, reach);
    switch (type) {
      case "project":
        return this.readProjects(actor, ids, reach);
      case "cycle":
        return this.readCycles(actor, ids, reach);
      case "release":
        return this.readReleases(actor, ids, reach);
      case "incident":
        return this.readIncidents(actor, ids, reach);
      default:
        return new Map();
    }
  }

  async optionsForProject(
    actor: EntityActor,
    projectId: number,
  ): Promise<EntityOption[]> {
    const rows = await this.db
      .select({
        userId: organizationMembers.userId,
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        image: users.image,
      })
      .from(projectMembers)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, projectMembers.orgId),
          eq(organizationMembers.id, projectMembers.membershipId),
        ),
      )
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(projectMembers.orgId, actor.orgId),
          eq(projectMembers.projectId, projectId),
        ),
      );

    return rows.map((row) => ({
      value: row.userId,
      label:
        row.name ??
        [row.firstName, row.lastName].filter(Boolean).join(" ").trim() ??
        row.email,
      imageUrl: row.image,
    }));
  }

  async resolveOwningProjectIds(
    actor: EntityActor,
    references: EntityReference[],
    resolutions: EntityResolution[],
  ): Promise<Map<number, number>> {
    const wanted = new Map<number, number>();
    references.forEach((reference, index) => {
      if (resolutions[index]?.status !== "resolved") return;
      if (isTicketType(reference.type)) {
        const id = numericId(reference);
        if (id !== null) wanted.set(index, id);
        return;
      }
      if (reference.type !== "project") return;
      const id = numericId(reference);
      if (id !== null) wanted.set(index, id);
    });
    if (wanted.size === 0) return new Map();

    const ticketIndexes = [...wanted].filter(([index]) =>
      isTicketType(references[index]?.type ?? ""),
    );
    const projectByIndex = new Map<number, number>();
    for (const [index] of wanted) {
      const reference = references[index];
      if (reference && reference.type === "project") {
        const id = numericId(reference);
        if (id !== null) projectByIndex.set(index, id);
      }
    }
    if (ticketIndexes.length === 0) return projectByIndex;

    const rows = await this.db
      .select({ id: tickets.id, projectId: tickets.projectId })
      .from(tickets)
      .where(
        and(
          eq(tickets.orgId, actor.orgId),
          inArray(
            tickets.id,
            ticketIndexes.map(([, ticketId]) => ticketId),
          ),
        ),
      );
    const projectByTicket = new Map(rows.map((row) => [row.id, row.projectId]));
    for (const [index, ticketId] of ticketIndexes) {
      const projectId = projectByTicket.get(ticketId);
      if (projectId !== null && projectId !== undefined)
        projectByIndex.set(index, projectId);
    }
    return projectByIndex;
  }

  private async keepReachable<T extends { projectId: number }>(
    actor: EntityActor,
    reach: SQL,
    rows: T[],
  ): Promise<T[]> {
    if (rows.length === 0) return rows;
    const projectIds = [...new Set(rows.map((row) => row.projectId))];
    const reachable = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.orgId, actor.orgId),
          inArray(projects.id, projectIds),
          isNull(projects.deletedAt),
          reach,
        ),
      )
      .limit(projectIds.length);
    const ids = new Set(reachable.map((row) => row.id));
    return rows.filter((row) => ids.has(row.projectId));
  }

  private async readTickets(
    type: string,
    ids: number[],
    scope: ScopedRead,
    reach: SQL,
  ): Promise<Map<number, EntityCard>> {
    if (scope.denied) return new Map();
    const rows = await this.db
      .select({
        id: tickets.id,
        title: tickets.title,
        status: tickets.status,
        ticketNumber: tickets.ticketNumber,
        projectId: tickets.projectId,
        projectKey: projects.key,
      })
      .from(tickets)
      .innerJoin(projects, eq(tickets.projectId, projects.id))
      .where(and(ticketVisibleSql(scope, reach), inArray(tickets.id, ids), isNull(tickets.deletedAt)))
      .limit(ids.length);

    return this.index(rows, (row) => ({
      type,
      id: String(row.id),
      title: row.title,
      subtitle: `${row.projectKey}-${row.ticketNumber}`,
      status: row.status,
      href: buildTicketHref(
        row.projectId,
        buildTicketKey(row.projectKey, row.ticketNumber),
      ),
    }));
  }

  private async readProjects(
    actor: EntityActor,
    ids: number[],
    reach: SQL,
  ): Promise<Map<number, EntityCard>> {
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
          eq(projects.orgId, actor.orgId),
          inArray(projects.id, ids),
          isNull(projects.deletedAt),
          reach,
        ),
      )
      .limit(ids.length);

    return this.index(rows, (row) => ({
      type: "project",
      id: String(row.id),
      title: row.name,
      subtitle: row.key,
      status: row.status,
      href: buildProjectHref(row.id),
    }));
  }

  private async readCycles(
    actor: EntityActor,
    ids: number[],
    reach: SQL,
  ): Promise<Map<number, EntityCard>> {
    const found = await this.db
      .select({
        id: cycles.id,
        name: cycles.name,
        status: cycles.status,
        projectId: cycles.projectId,
      })
      .from(cycles)
      .where(and(eq(cycles.orgId, actor.orgId), inArray(cycles.id, ids)))
      .limit(ids.length);
    const rows = await this.keepReachable(actor, reach, found);

    return this.index(rows, (row) => ({
      type: "cycle",
      id: String(row.id),
      title: row.name,
      subtitle: null,
      status: row.status,
      href: buildCycleListHref(row.projectId),
    }));
  }

  private async readReleases(
    actor: EntityActor,
    ids: number[],
    reach: SQL,
  ): Promise<Map<number, EntityCard>> {
    const found = await this.db
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
          eq(projectReleases.orgId, actor.orgId),
          inArray(projectReleases.id, ids),
          isNull(projectReleases.deletedAt),
        ),
      )
      .limit(ids.length);
    const rows = await this.keepReachable(actor, reach, found);

    return this.index(rows, (row) => ({
      type: "release",
      id: String(row.id),
      title: row.name,
      subtitle: row.version,
      status: row.status,
      href: buildReleaseListHref(row.projectId),
    }));
  }

  private async readIncidents(
    actor: EntityActor,
    ids: number[],
    reach: SQL,
  ): Promise<Map<number, EntityCard>> {
    const found = await this.db
      .select({
        id: projectIncidents.id,
        title: projectIncidents.title,
        incidentNumber: projectIncidents.incidentNumber,
        status: projectIncidents.status,
        severity: projectIncidents.severity,
        projectId: projectIncidents.projectId,
      })
      .from(projectIncidents)
      .where(
        and(
          eq(projectIncidents.orgId, actor.orgId),
          inArray(projectIncidents.id, ids),
          isNull(projectIncidents.deletedAt),
        ),
      )
      .limit(ids.length);
    const rows = await this.keepReachable(actor, reach, found);

    return this.index(rows, (row) => ({
      type: "incident",
      id: String(row.id),
      title: row.title,
      subtitle: `#${row.incidentNumber} · ${row.severity}`,
      status: row.status,
      href: buildIncidentHref(row.projectId, row.id),
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
