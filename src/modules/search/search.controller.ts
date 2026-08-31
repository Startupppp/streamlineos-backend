import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { Universal } from "../../common/auth/universal.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { SearchService } from "./search.service";
import { searchQuerySchema, type SearchQueryInput } from "./dto/search.schemas";

@Controller("search")
@UseGuards(JwtAuthGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @Universal()
  @Validate({ query: searchQuerySchema })
  @UseGuards(RateLimitGuard)
  @UseRateLimit("search:global")
  globalSearch(
    @Query() query: SearchQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.search.search(u, query.q, query.limit);
  }
}
