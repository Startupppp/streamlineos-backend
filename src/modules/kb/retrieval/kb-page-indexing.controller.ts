import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbIndexingService } from "./kb-indexing.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { z } from "zod";

const pageIdParams = z.object({ pageId: z.coerce.number().int().positive() }).strict();

@Controller("kb/pages")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbPageIndexingController {
  constructor(private readonly indexing: KbIndexingService) {}

  @Post(":pageId/reindex")
  @BodylessAction()
  @RequirePermission("kb:pages:manage")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: pageIdParams })
  async reindexPage(
    @CurrentUser() user: CurrentUserContext,
    @Param("pageId", ParseIntPipe) pageId: number,
  ): Promise<{ reindexed: boolean }> {
    await this.indexing.indexPage(user.orgId, pageId);
    return { reindexed: true };
  }

  @Post("reindex-all")
  @BodylessAction()
  @RequirePermission("kb:settings:manage")
  @HttpCode(HttpStatus.OK)
  async reindexAllPages(
    @CurrentUser() user: CurrentUserContext,
  ): Promise<{ reindexed: number }> {
    return this.indexing.reindexAllPages(user.orgId);
  }
}
