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
import { AiRequestAbortInterceptor } from "../../ai/core/streaming";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbIndexingService } from "./kb-indexing.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { z } from "zod";

const pageIdParams = z.object({ pageId: z.coerce.number().int().positive() }).strict();

/**
 * Both handlers are `@NoTenantTransaction()`, and both of them have to be.
 *
 * `reindexAllPages` walks up to `REINDEX_ALL_BATCH_SIZE` = 100 pages and awaits an embedding
 * round trip for each, so under the request transaction `TenantContextInterceptor` opens it
 * held one pooled connection idle-in-transaction for the whole walk — against the 60s
 * `idle_in_transaction_session_timeout` `withTenant` sets. Ten to sixty seconds in, the
 * timeout killed the transaction while the connection was still checked out mid-embed: a
 * tenant-wide 500 under pool pressure, with every embed already issued already billed.
 * `POST :pageId/reindex` is the same shape with one page instead of a hundred.
 *
 * Taking the transaction away is only half of it, and the missing half fails SILENTLY. Without
 * an ambient context the tenant-aware `db` proxy falls through to the pool with no tenant GUC,
 * and `kb_pages`' policy — read from `pg_policy` — is
 * `org_id = app.current_org_id_or_null() OR public_token = app.current_public_token_or_null()`.
 * The `_or_null` variant returns NULL where `app.current_org_id()` raises `42501`, so the bare
 * listing would not have 500'd: it would have matched nothing and answered
 * `{"reindexed":0,"nextPageId":null}` for a tenant with a thousand pages. So `KbIndexingService`
 * opens its own short transaction for the listing, and each `indexPage` passes an explicit
 * `orgId` and opens its own — which is what makes this decorator safe rather than a silent
 * no-op reported as success.
 *
 * `AiRequestAbortInterceptor` is the other half of the AI-module convention these routes were
 * missing: on a `@NoTenantTransaction()` route it is the only thing that arms cancellation, so
 * a client that hangs up mid-reindex stops paying for embeddings nobody will read.
 */
@Controller("kb/pages")
@UseGuards(JwtAuthGuard, PermissionGuard)
@UseInterceptors(AiRequestAbortInterceptor)
export class KbPageIndexingController {
  constructor(private readonly indexing: KbIndexingService) {}

  @Post(":pageId/reindex")
  @BodylessAction()
  @NoTenantTransaction()
  @RequirePermission("kb:pages:manage")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: pageIdParams })
  async reindexPage(
    @CurrentUser() user: CurrentUserContext,
    @Param("pageId", ParseIntPipe) pageId: number,
  ): Promise<{ reindexed: boolean }> {
    await this.indexing.reindexPageOnRequest(user.orgId, pageId);
    return { reindexed: true };
  }

  @Post("reindex-all")
  @BodylessAction()
  @NoTenantTransaction()
  @RequirePermission("kb:settings:manage")
  @HttpCode(HttpStatus.OK)
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
