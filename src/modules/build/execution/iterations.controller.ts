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
import { CyclesService } from "./cycles.service";
import { EpicsService } from "./epics.service";
import { ModulesService } from "./modules.service";
import { SprintsService } from "./sprints.service";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import {
  createCycleSchema,
  createEpicSchema,
  createModuleSchema,
  createSprintSchema,
  cycleListQuerySchema,
  moduleListQuerySchema,
  updateCycleSchema,
  updateEpicSchema,
  updateModuleSchema,
  updateSprintSchema,
  type CreateCycleInput,
  type CreateEpicInput,
  type CreateModuleInput,
  type CreateSprintInput,
  type CycleListQuery,
  type ModuleListQuery,
  type UpdateCycleInput,
  type UpdateEpicInput,
  type UpdateModuleInput,
  type UpdateSprintInput,
} from "./dto/iterations.schemas";
import { projectIdParams, projectAndSprintIdParams, projectAndCycleIdParams, projectAndModuleIdParams, projectAndEpicIdParams } from "./dto/iterations.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { successSchema } from "../../../common/openapi/response-envelopes";
import {
  sprintListItemSchema,
  sprintRowSchema,
  sprintDetailSchema,
  cycleListItemSchema,
  cycleRowSchema,
  moduleListItemSchema,
  modulePageSchema,
  moduleRowSchema,
  epicRowSchema,
} from "./dto/execution-response.schemas";

@RequireModule("build")
@Controller("build/:projectId/sprints")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SprintsController {
  constructor(private readonly sprints: SprintsService) {}

  @Get()
  @RequirePermission("build:cycles:view")
  @ResponseSchema(z.array(sprintListItemSchema))
  @Validate({ params: projectIdParams })
  listSprints(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sprints.listSprints(u.orgId, projectId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:cycles:manage")
  @Idempotent("build.sprint.create")
  @ResponseSchema(sprintRowSchema)
  @Validate({ params: projectIdParams, body: createSprintSchema })
  createSprint(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateSprintInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sprints.createSprint(u.orgId, projectId, body);
  }

  @Get(":sprintId")
  @RequirePermission("build:cycles:view")
  @ResponseSchema(sprintDetailSchema)
  @Validate({ params: projectAndSprintIdParams })
  getSprint(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("sprintId", ParseIntPipe) sprintId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sprints.getSprint(u.orgId, projectId, sprintId);
  }

  @Patch(":sprintId")
  @RequirePermission("build:cycles:manage")
  @ResponseSchema(successSchema)
  @Validate({ params: projectAndSprintIdParams, body: updateSprintSchema })
  updateSprint(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("sprintId", ParseIntPipe) sprintId: number,
    @Body() body: UpdateSprintInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sprints.updateSprint(u.orgId, projectId, sprintId, body, u.userId);
  }

  @Delete(":sprintId")
  @RequirePermission("build:cycles:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectAndSprintIdParams })
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
  @RequirePermission("build:cycles:view")
  @ResponseSchema(z.array(cycleListItemSchema))
  @Validate({ params: projectIdParams, query: cycleListQuerySchema })
  listCycles(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: CycleListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.cycles.listCycles(u.orgId, projectId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:cycles:manage")
  @Idempotent("build.cycle.create")
  @ResponseSchema(cycleRowSchema)
  @Validate({ params: projectIdParams, body: createCycleSchema })
  createCycle(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateCycleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.cycles.createCycle(u.orgId, u.userId, projectId, body);
  }

  @Patch(":cycleId")
  @RequirePermission("build:cycles:manage")
  @ResponseSchema(cycleRowSchema)
  @Validate({ params: projectAndCycleIdParams, body: updateCycleSchema })
  updateCycle(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("cycleId", ParseIntPipe) cycleId: number,
    @Body() body: UpdateCycleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.cycles.updateCycle(u.orgId, projectId, cycleId, body);
  }

  @Delete(":cycleId")
  @RequirePermission("build:cycles:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectAndCycleIdParams })
  deleteCycle(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("cycleId", ParseIntPipe) cycleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.cycles.deleteCycle(u.orgId, projectId, cycleId);
  }
}

@RequireModule("build")
@Controller("build/:projectId/modules")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ModulesController {
  constructor(private readonly modules: ModulesService) {}

  @Get()
  @RequirePermission("build:view")
  @ResponseSchema(modulePageSchema)
  @Validate({ params: projectIdParams, query: moduleListQuerySchema })
  listModules(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: ModuleListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.modules.listModules(u.orgId, projectId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:workspace:manage")
  @ResponseSchema(moduleRowSchema)
  @Validate({ params: projectIdParams, body: createModuleSchema })
  createModule(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateModuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.modules.createModule(u.orgId, u.userId, projectId, body);
  }

  @Patch(":moduleId")
  @RequirePermission("build:workspace:manage")
  @ResponseSchema(moduleRowSchema)
  @Validate({ params: projectAndModuleIdParams, body: updateModuleSchema })
  updateModule(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("moduleId", ParseIntPipe) moduleId: number,
    @Body() body: UpdateModuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.modules.updateModule(u.orgId, projectId, moduleId, body);
  }

  @Delete(":moduleId")
  @RequirePermission("build:workspace:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectAndModuleIdParams })
  deleteModule(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("moduleId", ParseIntPipe) moduleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.modules.deleteModule(u.orgId, projectId, moduleId);
  }
}

@RequireModule("build")
@Controller("build/:projectId/epics")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EpicsController {
  constructor(private readonly epics: EpicsService) {}

  @Get()
  @RequirePermission("build:tickets:view")
  @ResponseSchema(z.array(epicRowSchema))
  @Validate({ params: projectIdParams })
  listEpics(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.epics.listEpics(u.orgId, projectId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:tickets:create")
  @ResponseSchema(epicRowSchema)
  @Validate({ params: projectIdParams, body: createEpicSchema })
  createEpic(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateEpicInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.epics.createEpic(u.orgId, u.userId, projectId, body);
  }

  @Patch(":epicId")
  @RequirePermission("build:tickets:update")
  @ResponseSchema(epicRowSchema)
  @Validate({ params: projectAndEpicIdParams, body: updateEpicSchema })
  updateEpic(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("epicId", ParseIntPipe) epicId: number,
    @Body() body: UpdateEpicInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.epics.updateEpic(u.orgId, projectId, epicId, body);
  }

  @Delete(":epicId")
  @RequirePermission("build:tickets:delete")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectAndEpicIdParams })
  deleteEpic(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("epicId", ParseIntPipe) epicId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.epics.deleteEpic(u.orgId, projectId, epicId);
  }
}
