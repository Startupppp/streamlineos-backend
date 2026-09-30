import { BadRequestException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../../common/rbac/access-invalidate";
import { roles } from "../../db/schema";
import { ACCESS_MANAGED_MODULES, MODULE_CATALOG } from "../../common/rbac/module-vocabulary";

export type ModuleStanding = "MEMBER" | "ADMIN";

export interface ResolvedModuleRole {
  id: number;
  rank: number;
  moduleKey: string;
  slug: string;
}

function slugForStanding(moduleKey: string, standing: ModuleStanding): string {
  if (standing === "MEMBER") return `${moduleKey.toUpperCase()}_MODULE_MEMBER`;
  return `${moduleKey.toUpperCase()}_MODULE_ADMIN`;
}

const ACCESS_MANAGED_SET: ReadonlySet<string> = new Set(ACCESS_MANAGED_MODULES);
const MODULE_ADMIN_SET: ReadonlySet<string> = new Set([
  ...MODULE_CATALOG,
  ...ACCESS_MANAGED_MODULES,
]);

export function validateModuleKeyAndStanding(moduleKey: string, standing: ModuleStanding): void {
  if (standing === "MEMBER" && !ACCESS_MANAGED_SET.has(moduleKey)) {
    throw new BadRequestException(
      `Module "${moduleKey}" does not support standing MEMBER (not an access-managed module)`,
    );
  }
  if (standing === "ADMIN" && !MODULE_ADMIN_SET.has(moduleKey)) {
    throw new BadRequestException(
      `Module "${moduleKey}" does not support standing ADMIN (not a known module)`,
    );
  }
  if (!ACCESS_MANAGED_SET.has(moduleKey) && !MODULE_ADMIN_SET.has(moduleKey)) {
    throw new BadRequestException(`Unknown module key: "${moduleKey}"`);
  }
}

export async function resolveModuleStandingRole(
  tx: DbOrTx,
  orgId: string,
  moduleKey: string,
  standing: ModuleStanding,
): Promise<ResolvedModuleRole | null> {
  const slug = slugForStanding(moduleKey, standing);
  const [found] = await tx
    .select({ id: roles.id, rank: roles.rank, moduleKey: roles.moduleKey, slug: roles.slug })
    .from(roles)
    .where(and(eq(roles.orgId, orgId), eq(roles.slug, slug)))
    .limit(1);
  if (!found || found.moduleKey === null) return null;
  return { id: found.id, rank: found.rank, moduleKey: found.moduleKey, slug: found.slug };
}
