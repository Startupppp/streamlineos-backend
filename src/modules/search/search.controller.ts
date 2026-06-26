import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SearchService } from "./search.service";
import { searchQuerySchema, type SearchQueryInput } from "./dto/search.schemas";

@Controller("search")
@UseGuards(JwtAuthGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  globalSearch(
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.search.search(u.orgId, u.userId, query.q, query.limit);
  }
}
