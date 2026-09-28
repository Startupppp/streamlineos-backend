import { and, eq, isNull } from "drizzle-orm";
import { type Db } from "../../../db/drizzle.module";
import { projects } from "../../../db/schema";
import type { EntityActor } from "../../entity-reference/entity-reference.types";
import { reachableProjectsSql } from "../reachability/project-reachability";

export function text(input: Record<string, unknown>, name: string): string | null {
  const value = input[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function isProjectMember(
  db: Db,
  actor: EntityActor,
  projectId: number,
): Promise<boolean> {
  if (actor.isOrgOwner) return true;
  const membershipId = actor.membershipId ?? -1;
  const row = await db.query.projects.findFirst({
    where: and(
      eq(projects.id, projectId),
      eq(projects.orgId, actor.orgId),
      isNull(projects.deletedAt),
      reachableProjectsSql(actor.orgId, membershipId),
    ),
    columns: { id: true },
  });
  return Boolean(row);
}
