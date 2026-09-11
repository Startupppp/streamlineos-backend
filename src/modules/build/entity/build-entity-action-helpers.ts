import { and, eq } from "drizzle-orm";
import { type Db } from "../../../db/drizzle.module";
import { projectMembers } from "../../../db/schema";
import type { EntityActor } from "../../entity-reference/entity-reference.types";

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
  const membership = await db.query.projectMembers.findFirst({
    where: and(
      eq(projectMembers.orgId, actor.orgId),
      eq(projectMembers.projectId, projectId),
      eq(projectMembers.membershipId, actor.membershipId ?? -1),
    ),
    columns: { projectId: true },
  });
  return Boolean(membership);
}
