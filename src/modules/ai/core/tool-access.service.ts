import { Injectable } from "@nestjs/common";
import { AccessService } from "../../access/access.service";
import { permissionAreaLabel } from "../../../common/rbac/module-vocabulary";
import type { ScopedRead } from "../../access/scoped-read";
import { resolveToolScope } from "./ai-tool-scope";

@Injectable()
export class ToolAccessService {
  constructor(private readonly access: AccessService) {}

  async scope(orgId: string, userId: string, key: string): Promise<ScopedRead> {
    return resolveToolScope(this.access, { orgId, userId }, key);
  }

  async denyReason(
    orgId: string,
    userId: string,
    key: string,
  ): Promise<string | null> {
    const read = await this.scope(orgId, userId, key);
    if (read.denied) {
      return `Permission denied: you do not have access to ${permissionAreaLabel(key)} data.`;
    }
    return null;
  }
}
