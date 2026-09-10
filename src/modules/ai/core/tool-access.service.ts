import { Injectable } from "@nestjs/common";
import { AccessService } from "../../access/access.service";
import { permissionAreaLabel } from "../../../common/rbac/module-vocabulary";
import type { DataScope } from "../../access/access.types";

@Injectable()
export class ToolAccessService {
  constructor(private readonly access: AccessService) {}

  async scope(orgId: string, userId: string, key: string): Promise<DataScope> {
    const perms = await this.access.resolveUserPermissions(orgId, userId);
    return perms.get(key) ?? "none";
  }

  async denyReason(orgId: string, userId: string, key: string): Promise<string | null> {
    const s = await this.scope(orgId, userId, key);
    if (s === "none") {
      return `Permission denied: you do not have access to ${permissionAreaLabel(key)} data.`;
    }
    return null;
  }
}
