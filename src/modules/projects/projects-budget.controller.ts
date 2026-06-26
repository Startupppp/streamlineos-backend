import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ProjectsBudgetService } from "./projects-budget.service";
import { updateBudgetSchema, type UpdateBudgetInput } from "./dto/projects.schemas";

@Controller("projects")
@UseGuards(JwtAuthGuard)
export class ProjectsBudgetController {
  constructor(private readonly budget: ProjectsBudgetService) {}

  @Get(":projectId/budget")
  getBudget(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budget.getBudget(u, projectId);
  }

  @Patch(":projectId/budget")
  updateBudget(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(updateBudgetSchema)) body: UpdateBudgetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budget.updateBudget(u, projectId, body);
  }
}
