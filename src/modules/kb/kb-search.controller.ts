import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { KbSearchService } from "./kb-search.service";
import { searchSchema, type SearchInput } from "./dto/kb-ai.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, ModuleGuard, AbilityGuard)
@RequireModule("kb")
export class KbSearchController {
  constructor(private readonly search: KbSearchService) {}

  @Get("search")
  @CheckAbility("view", "kb:articles")
  searchArticles(
    @Query(new ZodValidationPipe(searchSchema)) query: SearchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.search.search(u, query);
  }
}
