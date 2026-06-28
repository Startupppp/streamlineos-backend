import { Controller, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { KbIndexingService } from "./kb-indexing.service";

@Controller("kb")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
@RequireModule("kb")
export class KbIndexingController {
  constructor(private readonly indexing: KbIndexingService) {}

  @Post("articles/reindex-all")
  @RequirePermission("kb:articles:manage")
  async reindexAll(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return await this.indexing.reindexAll(u.orgId);
  }
}
