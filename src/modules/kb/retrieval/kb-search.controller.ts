import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { KbSearchService } from "./kb-search.service";
import { resolveKbArticlesViewScope } from "../core/kb-scope";
import { searchSchema, type SearchInput } from "./dto/kb-ai.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequireModule("kb")
export class KbSearchController {
  constructor(
    private readonly search: KbSearchService,
    private readonly access: AccessService,
  ) {}

  @Get("search")
  @RequirePermission("kb:articles:view")
  @Validate({ query: searchSchema })
  async searchArticles(
    @Query() query: SearchInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    const scope = await resolveKbArticlesViewScope(this.access, u);
    return await this.search.search(u, query, scope);
  }
}
