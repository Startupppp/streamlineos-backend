import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { KbIndexingService } from "./kb-indexing.service";

@Controller("kb/pages")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
@RequireModule("kb")
export class KbPageIndexingController {
  constructor(private readonly indexing: KbIndexingService) {}

  @Post(":pageId/reindex")
  @RequirePermission("kb:pages:manage")
  @HttpCode(HttpStatus.OK)
  async reindexPage(
    @CurrentUser() user: CurrentUserContext,
    @Param("pageId", ParseIntPipe) pageId: number,
  ): Promise<{ reindexed: boolean }> {
    await this.indexing.indexPage(user.orgId, pageId);
    return { reindexed: true };
  }

  @Post("reindex-all")
  @RequirePermission("kb:settings:manage")
  @HttpCode(HttpStatus.OK)
  async reindexAllPages(
    @CurrentUser() user: CurrentUserContext,
  ): Promise<{ reindexed: number }> {
    return this.indexing.reindexAllPages(user.orgId);
  }
}
