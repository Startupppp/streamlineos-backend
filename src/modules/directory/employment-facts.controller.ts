import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { EmploymentFactsService } from "./employment-facts.service";
import {
  listEmploymentFactsQuerySchema,
  type ListEmploymentFactsQuery,
} from "./dto/employment-facts.schemas";
import type { EmploymentFacts } from "./employment-facts.types";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { employmentFactsListSchema } from "./dto/directory-response.schemas";

@Controller("directory/employment")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EmploymentFactsController {
  constructor(private readonly facts: EmploymentFactsService) {}

  @Get()
  @RequirePermission("settings:view")
  @ResponseSchema(employmentFactsListSchema)
  @Validate({ query: listEmploymentFactsQuerySchema })
  async list(
    @Query() query: ListEmploymentFactsQuery,
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
