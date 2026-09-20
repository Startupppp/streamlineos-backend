import { Injectable } from "@nestjs/common";
import { AccessService } from "../../access/access.service";
import type { ScopedRead } from "../../access/scoped-read";
import { resolveAskOsToolRead } from "./ask-os-tool-scope";
import { toolDenialReason } from "./registry/ask-os-tool.types";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { AuthContext } from "../../../common/auth/auth-context";

@Injectable()
export class ToolAccessService {
  constructor(private readonly access: AccessService) {}

  async scope(
    actor: CurrentUserContext,
    key: string,
    authContext?: AuthContext,
  ): Promise<ScopedRead> {
    return resolveAskOsToolRead(this.access, actor, key, authContext);
  }

  async denyReason(
    actor: CurrentUserContext,
    key: string,
    authContext?: AuthContext,
  ): Promise<string | null> {
    const read = await this.scope(actor, key, authContext);
    return read.denied ? toolDenialReason(key) : null;
  }
}
