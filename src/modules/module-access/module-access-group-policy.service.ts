import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { resolveModuleOwnerUserId } from "./module-access.helpers";
import { roles } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { PERMISSIONS } from "../rbac/permissions";
import { administeringModuleOf } from "../../common/rbac/module-vocabulary";

@Injectable()
export class ModuleAccessGroupPolicyService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  permissionKeys(moduleKey: string): Set<string> {
    return new Set(
      PERMISSIONS.filter((permission) => administeringModuleOf(permission.name) === moduleKey).map(
        (permission) => permission.name,
      ),
    );
  }

  async assertGroupBelongsToModule(
    orgId: string,
    moduleKey: string,
    groupId: number,
  ): Promise<void> {
    const role = await this.db.query.roles.findFirst({
      where: and(eq(roles.id, groupId), eq(roles.orgId, orgId), eq(roles.moduleKey, moduleKey)),
      columns: { id: true },
    });
    if (!role) throw new NotFoundException("Group not found");
  }

  async resolveOwnerUserId(orgId: string, moduleKey: string): Promise<string | null> {
    return resolveModuleOwnerUserId(this.db, orgId, moduleKey);
  }

}
