import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Universal } from "../../common/auth/universal.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { EmploymentFactsService } from "./employment-facts.service";
import {
  listEmploymentFactsQuerySchema,
  type ListEmploymentFactsQuery,
} from "./dto/employment-facts.schemas";
import type { EmploymentFacts } from "./employment-facts.types";

@Controller("directory/employment")
@UseGuards(JwtAuthGuard)
export class EmploymentFactsController {
  constructor(private readonly facts: EmploymentFactsService) {}

  @Get()
  @Universal()
  async list(
    @Query(new ZodValidationPipe(listEmploymentFactsQuerySchema))
    query: ListEmploymentFactsQuery,
    @CurrentUser() user: CurrentUserContext,
  ): Promise<{ data: EmploymentFacts[] }> {
    const resolved = await this.facts.getFactsBatch(user.orgId, query.userIds);
    return {
      data: query.userIds
        .map((id) => resolved.get(id))
        .filter((facts): facts is EmploymentFacts => facts !== undefined),
    };
  }
}
