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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { CyclesService, EpicsService, ModulesService, SprintsService } from "./iterations.service";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import {
  createCycleSchema,
  createEpicSchema,
  createModuleSchema,
  createSprintSchema,
  cycleListQuerySchema,
  updateCycleSchema,
  updateEpicSchema,
  updateModuleSchema,
  updateSprintSchema,
  type CreateCycleInput,
  type CreateEpicInput,
  type CreateModuleInput,
  type CreateSprintInput,
  type CycleListQuery,
  type UpdateCycleInput,
  type UpdateEpicInput,
  type UpdateModuleInput,
  type UpdateSprintInput,
} from "./dto/iterations.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const sprintIdParams = z.object({ sprintId: z.coerce.number().int().positive() }).strict();
const cycleIdParams = z.object({ cycleId: z.coerce.number().int().positive() }).strict();
const moduleIdParams = z.object({ moduleId: z.coerce.number().int().positive() }).strict();
const epicIdParams = z.object({ epicId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build/:projectId/sprints")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SprintsController {
  constructor(private readonly sprints: SprintsService) {}

  @Get()
  @RequirePermission("build:sprints:view")
  listSprints(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sprints.listSprints(u.orgId, projectId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:sprints:manage")
  @Idempotent("build.sprint.create")
  createSprint(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createSprintSchema)) body: CreateSprintInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sprints.createSprint(u.orgId, projectId, body);
  }

  @Get(":sprintId")
  @RequirePermission("build:sprints:view")
  @Validate({ params: sprintIdParams })
  getSprint(
    @Param("sprintId", ParseIntPipe) sprintId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sprints.getSprint(u.orgId, sprintId);
  }

  @Patch(":sprintId")
  @RequirePermission("build:sprints:manage")
  @Validate({ params: sprintIdParams })
  updateSprint(
    @Param("sprintId", ParseIntPipe) sprintId: number,
    @Body(new ZodValidationPipe(updateSprintSchema)) body: UpdateSprintInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sprints.updateSprint(u.orgId, sprintId, body, u.userId);
  }

  @Delete(":sprintId")
  @RequirePermission("build:sprints:manage")
  @HttpCode(204)
  @Validate({ params: sprintIdParams })
  deleteSprint(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("sprintId", ParseIntPipe) sprintId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sprints.deleteSprint(u.orgId, projectId, sprintId);
  }
}

@RequireModule("build")
@Controller("build/:projectId/cycles")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CyclesController {
  constructor(private readonly cycles: CyclesService) {}

  @Get()
  @RequirePermission("build:view")
  listCycles(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query(new ZodValidationPipe(cycleListQuerySchema)) query: CycleListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.cycles.listCycles(u.orgId, projectId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:workspace:manage")
  @Idempotent("build.cycle.create")
  createCycle(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createCycleSchema)) body: CreateCycleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.cycles.createCycle(u.orgId, u.userId, projectId, body);
  }

  @Patch(":cycleId")
  @RequirePermission("build:workspace:manage")
  @Validate({ params: cycleIdParams })
  updateCycle(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("cycleId", ParseIntPipe) cycleId: number,
    @Body(new ZodValidationPipe(updateCycleSchema)) body: UpdateCycleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.cycles.updateCycle(u.orgId, projectId, cycleId, body);
  }

  @Delete(":cycleId")
  @RequirePermission("build:workspace:manage")
  @HttpCode(204)
  @Validate({ params: cycleIdParams })
  deleteCycle(
    @Param("cycleId", ParseIntPipe) cycleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.cycles.deleteCycle(u.orgId, cycleId);
  }
}

@RequireModule("build")
@Controller("build/:projectId/modules")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ModulesController {
  constructor(private readonly modules: ModulesService) {}

  @Get()
  @RequirePermission("build:view")
  listModules(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.modules.listModules(u.orgId, projectId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:workspace:manage")
  createModule(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createModuleSchema)) body: CreateModuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.modules.createModule(u.orgId, u.userId, projectId, body);
  }

  @Patch(":moduleId")
  @RequirePermission("build:workspace:manage")
  @Validate({ params: moduleIdParams })
  updateModule(
    @Param("moduleId", ParseIntPipe) moduleId: number,
    @Body(new ZodValidationPipe(updateModuleSchema)) body: UpdateModuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.modules.updateModule(u.orgId, moduleId, body);
  }

  @Delete(":moduleId")
  @RequirePermission("build:workspace:manage")
  @HttpCode(204)
  @Validate({ params: moduleIdParams })
  deleteModule(
    @Param("moduleId", ParseIntPipe) moduleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.modules.deleteModule(u.orgId, moduleId);
  }
}

@RequireModule("build")
@Controller("build/:projectId/epics")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EpicsController {
  constructor(private readonly epics: EpicsService) {}

  @Get()
  @RequirePermission("build:tickets:view")
  listEpics(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.epics.listEpics(u.orgId, projectId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:tickets:create")
  createEpic(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createEpicSchema)) body: CreateEpicInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.epics.createEpic(u.orgId, u.userId, projectId, body);
  }

  @Patch(":epicId")
  @RequirePermission("build:tickets:update")
  @Validate({ params: epicIdParams })
  updateEpic(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("epicId", ParseIntPipe) epicId: number,
    @Body(new ZodValidationPipe(updateEpicSchema)) body: UpdateEpicInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.epics.updateEpic(u.orgId, projectId, epicId, body);
  }

  @Delete(":epicId")
  @RequirePermission("build:tickets:delete")
  @HttpCode(204)
  @Validate({ params: epicIdParams })
  deleteEpic(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("epicId", ParseIntPipe) epicId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.epics.deleteEpic(u.orgId, projectId, epicId);
  }
}
