import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { KbSearchService } from "./kb-search.service";
import { searchSchema, type SearchInput } from "./dto/kb-ai.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbSearchController {
  constructor(private readonly search: KbSearchService) {}

  @Get("search")
  @RequirePermission("kb:articles:view")
  async searchArticles(
    @Query(new ZodValidationPipe(searchSchema)) query: SearchInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.search.search(u, query);
  }
}
