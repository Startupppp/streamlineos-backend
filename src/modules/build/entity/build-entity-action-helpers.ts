import type { SQL } from "drizzle-orm";
import { type Db } from "../../../db/drizzle.module";
import type { Permissions } from "../../entity-reference/entity-scope";
import type { EntityActionFailure, EntityActor } from "../../entity-reference/entity-reference.types";
import { decideProjectWrite } from "../core/project-crud/project-access";
import { projectReachFor } from "../core/project-crud/project-relationship";
import { resolveEntityCardScope } from "./build-entity-scope";

export function text(input: Record<string, unknown>, name: string): string | null {
  const value = input[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function entityProjectReach(actor: EntityActor, permissions: Permissions): SQL {
  return projectReachFor(
    (key) => resolveEntityCardScope(actor, permissions, key),
    actor.orgId,
    actor.membershipId ?? null,
  );
}

export async function entityProjectWriteRefusal(
  db: Db,
  actor: EntityActor,
  reach: SQL,
  projectId: number,
): Promise<EntityActionFailure | null> {
  const decision = await decideProjectWrite(db, actor.orgId, projectId, reach);
  if (decision === "allowed") return null;
  return decision === "missing" ? "not-found" : "forbidden";
}
