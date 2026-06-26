import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { CyclesService, EpicsService, ModulesService, SprintsService } from "./iterations.service";
import {
  createCycleSchema,
  createEpicSchema,
  createModuleSchema,
  createSprintSchema,
  cycleListQuerySchema,
  updateCycleSchema,
  updateModuleSchema,
  updateSprintSchema,
  type CreateCycleInput,
  type CreateEpicInput,
  type CreateModuleInput,
  type CreateSprintInput,
  type CycleListQuery,
  type UpdateCycleInput,
  type UpdateModuleInput,
  type UpdateSprintInput,
} from "./dto/iterations.schemas";

@Controller("projects/:projectId/sprints")
@UseGuards(JwtAuthGuard)
export class SprintsController {
  constructor(private readonly sprints: SprintsService) {}

  @Get()
  listSprints(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sprints.listSprints(u.orgId, projectId);
  }

  @Post()
  @UseGuards(ModuleGuard, AbilityGuard)
  @RequireModule("projects")
  @CheckAbility("manage", "projects:sprints")
  @HttpCode(201)
  createSprint(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createSprintSchema)) body: CreateSprintInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sprints.createSprint(u.orgId, projectId, body);
  }

  @Get(":sprintId/burndown")
  burndown(
    @Param("sprintId", ParseIntPipe) sprintId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sprints.burndown(u.orgId, sprintId);
  }

  @Get(":sprintId")
  getSprint(
    @Param("sprintId", ParseIntPipe) sprintId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sprints.getSprint(u.orgId, sprintId);
  }

  @Patch(":sprintId")
  @UseGuards(ModuleGuard, AbilityGuard)
  @RequireModule("projects")
  @CheckAbility("manage", "projects:sprints")
  updateSprint(
    @Param("sprintId", ParseIntPipe) sprintId: number,
    @Body(new ZodValidationPipe(updateSprintSchema)) body: UpdateSprintInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sprints.updateSprint(u.orgId, sprintId, body);
  }
}

@Controller("projects/:projectId/cycles")
@UseGuards(JwtAuthGuard)
export class CyclesController {
  constructor(private readonly cycles: CyclesService) {}

  @Get()
  listCycles(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query(new ZodValidationPipe(cycleListQuerySchema)) query: CycleListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.cycles.listCycles(u.orgId, projectId, query);
  }

  @Post()
  @HttpCode(201)
  createCycle(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createCycleSchema)) body: CreateCycleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.cycles.createCycle(u.orgId, u.userId, projectId, body);
  }

  @Patch(":cycleId")
  updateCycle(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("cycleId", ParseIntPipe) cycleId: number,
    @Body(new ZodValidationPipe(updateCycleSchema)) body: UpdateCycleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.cycles.updateCycle(u.orgId, projectId, cycleId, body);
  }

  @Delete(":cycleId")
  deleteCycle(
    @Param("cycleId", ParseIntPipe) cycleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.cycles.deleteCycle(u.orgId, cycleId);
  }
}

@Controller("projects/:projectId/modules")
@UseGuards(JwtAuthGuard)
export class ModulesController {
  constructor(private readonly modules: ModulesService) {}

  @Get()
  listModules(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.modules.listModules(u.orgId, projectId);
  }

  @Post()
  @HttpCode(201)
  createModule(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createModuleSchema)) body: CreateModuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.modules.createModule(u.orgId, u.userId, projectId, body);
  }

  @Patch(":moduleId")
  updateModule(
    @Param("moduleId", ParseIntPipe) moduleId: number,
    @Body(new ZodValidationPipe(updateModuleSchema)) body: UpdateModuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.modules.updateModule(u.orgId, moduleId, body);
  }

  @Delete(":moduleId")
  deleteModule(
    @Param("moduleId", ParseIntPipe) moduleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.modules.deleteModule(u.orgId, moduleId);
  }
}

@Controller("projects/:projectId/epics")
@UseGuards(JwtAuthGuard)
export class EpicsController {
  constructor(private readonly epics: EpicsService) {}

  @Get()
  listEpics(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.epics.listEpics(u.orgId, projectId);
  }

  @Post()
  @HttpCode(201)
  createEpic(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createEpicSchema)) body: CreateEpicInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.epics.createEpic(u.orgId, u.userId, projectId, body);
  }
}
