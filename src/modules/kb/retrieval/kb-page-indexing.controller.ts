import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { NoTenantTransaction } from "../../../common/tenant/no-tenant-transaction.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { AiRequestAbortInterceptor } from "../../ai/core/streaming";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbIndexingService } from "./kb-indexing.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { kbReindexPageSchema, kbReindexAllSchema } from "./dto/kb-retrieval-response.schemas";
import { z } from "zod";

const pageIdParams = z.object({ pageId: z.coerce.number().int().positive() }).strict();

@Controller("kb/pages")
@UseGuards(JwtAuthGuard, PermissionGuard)
@UseInterceptors(AiRequestAbortInterceptor)
export class KbPageIndexingController {
  constructor(private readonly indexing: KbIndexingService) {}

  @Post(":pageId/reindex")
  @BodylessAction()
  @Idempotent("kb.page.reindex")
  @NoTenantTransaction()
  @RequirePermission("kb:pages:manage")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: pageIdParams })
  @ResponseSchema(kbReindexPageSchema)
  async reindexPage(
    @CurrentUser() user: CurrentUserContext,
    @Param("pageId", ParseIntPipe) pageId: number,
  ): Promise<{ reindexed: boolean }> {
    await this.indexing.reindexPageOnRequest(user.orgId, pageId);
    return { reindexed: true };
  }

  @Post("reindex-all")
  @BodylessAction()
  @Idempotent("kb.pages.reindex-all")
  @NoTenantTransaction()
  @RequirePermission("kb:settings:manage")
  @HttpCode(HttpStatus.OK)
  @ResponseSchema(kbReindexAllSchema)
  async reindexAllPages(
    @CurrentUser() user: CurrentUserContext,
    @Query("afterPageId") afterPageId?: string,
  ): Promise<{ reindexed: number; nextPageId: number | null }> {
    const cursor = afterPageId === undefined ? 0 : Number(afterPageId);
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new BadRequestException("afterPageId must be a non-negative integer");
    return this.indexing.reindexAllPages(user.orgId, cursor);
  }
}
