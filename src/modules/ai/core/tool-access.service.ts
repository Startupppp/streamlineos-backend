import { Injectable } from "@nestjs/common";
import { AccessService } from "../../access/access.service";
import { ScopedRead } from "../../access/scoped-read";
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
    return ScopedRead.of(
      actor.orgId,
      actor.userId,
      await this.access.scopeFor(actor, key, authContext),
    );
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
