import { and, eq, isNull } from "drizzle-orm";
import {
  clients,
  projectIncidents,
  projectReleases,
  projects,
  sprints,
  tickets,
} from "../../db/schema";
import type { Db } from "../../db/drizzle.module";

const ENTITY_CHANNEL_TYPES = [
  "project",
  "client",
  "task",
  "sprint",
  "release",
  "incident",
] as const;

export type EntityChannelType = (typeof ENTITY_CHANNEL_TYPES)[number];

export function isEntityChannelType(value: string): value is EntityChannelType {
  return (ENTITY_CHANNEL_TYPES as readonly string[]).includes(value);
}

export function isStaleEntityChannelName(
  name: string,
  entityType: string,
  entityId: string,
): boolean {
  const label = entityType.charAt(0).toUpperCase() + entityType.slice(1);
  return name === `${label}: ${entityId}`;
}

export async function resolveEntityChannelName(
  db: Db,
  entityType: string,
  entityId: string,
  orgId: string,
): Promise<string | null> {
  const parsedId = Number(entityId);
  if (!Number.isInteger(parsedId) || parsedId <= 0) return null;
  if (!isEntityChannelType(entityType)) return null;

  switch (entityType) {
    case "project": {
      const row = await db.query.projects.findFirst({
        where: and(eq(projects.id, parsedId), eq(projects.orgId, orgId), isNull(projects.deletedAt)),
        columns: { name: true },
      });
      return row?.name ?? null;
    }
    case "client": {
      const row = await db.query.clients.findFirst({
        where: and(eq(clients.id, parsedId), eq(clients.orgId, orgId)),
        columns: { name: true },
      });
      return row?.name ?? null;
    }
    case "task": {
      const row = await db.query.tickets.findFirst({
        where: and(eq(tickets.id, parsedId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)),
        columns: { title: true },
      });
      return row?.title ?? null;
    }
    case "sprint": {
      const row = await db.query.sprints.findFirst({
        where: and(eq(sprints.id, parsedId), eq(sprints.orgId, orgId), isNull(sprints.deletedAt)),
        columns: { name: true },
      });
      return row?.name ?? null;
    }
    case "release": {
      const row = await db.query.projectReleases.findFirst({
        where: and(eq(projectReleases.id, parsedId), eq(projectReleases.orgId, orgId)),
        columns: { name: true },
      });
      return row?.name ?? null;
    }
    case "incident": {
      const row = await db.query.projectIncidents.findFirst({
        where: and(eq(projectIncidents.id, parsedId), eq(projectIncidents.orgId, orgId)),
        columns: { title: true },
      });
      return row?.title ?? null;
    }
    default:
      return null;
  }
}
