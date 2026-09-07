import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ProjectsBudgetService } from "./projects-budget.service";
import { updateBudgetSchema, type UpdateBudgetInput } from "./dto/projects.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { projectBudgetSchema, projectBudgetUpdateSchema } from "./dto/build-reports-response.schemas";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsBudgetController {
  constructor(private readonly budget: ProjectsBudgetService) {}

  @Get(":projectId/budget")
  @RequirePermission("build:manage")
  @ResponseSchema(projectBudgetSchema)
  @Validate({ params: projectIdParams })
  getBudget(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budget.getBudget(u, projectId);
  }

  @Patch(":projectId/budget")
  @RequirePermission("build:manage")
  @ResponseSchema(projectBudgetUpdateSchema)
  @Validate({ params: projectIdParams, body: updateBudgetSchema })
  updateBudget(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: UpdateBudgetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budget.updateBudget(u, projectId, body);
  }
}
