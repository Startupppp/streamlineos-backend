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
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ProjectsBudgetService } from "./projects-budget.service";
import { updateBudgetSchema, type UpdateBudgetInput } from "./dto/projects.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsBudgetController {
  constructor(private readonly budget: ProjectsBudgetService) {}

  @Get(":projectId/budget")
  @RequirePermission("build:manage")
  @Validate({ params: projectIdParams })
  getBudget(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budget.getBudget(u, projectId);
  }

  @Patch(":projectId/budget")
  @RequirePermission("build:manage")
  @Validate({ params: projectIdParams })
  updateBudget(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(updateBudgetSchema)) body: UpdateBudgetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budget.updateBudget(u, projectId, body);
  }
}
