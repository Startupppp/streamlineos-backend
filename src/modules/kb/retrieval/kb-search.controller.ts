import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { KbSearchService } from "./kb-search.service";
import { KbPageSearchQueryService } from "./kb-page-search-query.service";
import { resolveKbArticlesViewScope } from "../core/kb-scope";
import { searchSchema, type SearchInput } from "./dto/kb-ai.schemas";
import { pageFullSearchQuerySchema, kbPageFullSearchResponseSchema, type PageFullSearchQuery } from "./dto/kb-page-search-query.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { kbSearchResponseSchema } from "./dto/kb-retrieval-response.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbSearchController {
  constructor(
    private readonly search: KbSearchService,
    private readonly access: AccessService,
    private readonly pageSearch: KbPageSearchQueryService,
  ) {}

  @Get("search")
  @RequirePermission("kb:articles:view")
  @Validate({ query: searchSchema })
  @ResponseSchema(kbSearchResponseSchema)
  async searchArticles(
    @Query() query: SearchInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    const scope = await resolveKbArticlesViewScope(this.access, u);
    return await this.search.search(u, query, scope);
  }

  @Get("pages/full-search")
  @RequirePermission("kb:pages:view")
  @Validate({ query: pageFullSearchQuerySchema })
  @ResponseSchema(kbPageFullSearchResponseSchema)
  async searchPages(
    @Query() query: PageFullSearchQuery,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.pageSearch.search(u, query);
  }
}
