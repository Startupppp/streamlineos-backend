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
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { PositionsService } from "./positions.service";
import {
  createPositionSchema,
  updatePositionSchema,
  listPositionsSchema,
  assignPositionSchema,
  createReorgScenarioSchema,
  updateReorgScenarioSchema,
  listScenariosSchema,
  type CreatePositionInput,
  type UpdatePositionInput,
  type ListPositionsInput,
  type AssignPositionInput,
  type CreateReorgScenarioInput,
  type UpdateReorgScenarioInput,
  type ListScenariosInput,
} from "./positions.dto";
import { Validate } from "../../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema, NoContentResponse } from "../../../../common/openapi/zod-operation-contracts"
import { listPositionsResponseSchema, listVacantPositionsResponseSchema, createPositionResponseSchema, updatePositionResponseSchema, assignPositionResponseSchema, listScenariosResponseSchema, createScenarioResponseSchema, updateScenarioResponseSchema, simulateScenarioResponseSchema } from "../dto/governance-response.schemas"

const positionIdParams = z.object({ positionId: z.coerce.number().int().positive() }).strict();
const scenarioIdParams = z.object({ scenarioId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/governance")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PositionsController {
  constructor(private readonly service: PositionsService) {}

  @ResponseSchema(listPositionsResponseSchema)
  @Get("positions")
  @RequirePermission("hr:positions:view")
  @Validate({ query: listPositionsSchema })
  async list(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ListPositionsInput,
  ) {
    return this.service.list(user.orgId, query);
  }

  @ResponseSchema(listVacantPositionsResponseSchema)
  @Get("positions/vacant")
  @RequirePermission("hr:positions:view")
  @Validate({ query: listPositionsSchema })
  async listVacant(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ListPositionsInput,
  ) {
    return this.service.listVacant(user.orgId, query);
  }

  @ResponseSchema(createPositionResponseSchema)
  @Post("positions")
  @RequirePermission("hr:positions:manage")
  @Validate({ body: createPositionSchema })
  async create(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: CreatePositionInput,
    @Req() req: Request,
  ) {
    return this.service.create(user.orgId, user.userId, body, req.ip);
  }

  @ResponseSchema(updatePositionResponseSchema)
  @Patch("positions/:positionId")
  @RequirePermission("hr:positions:manage")
  @Validate({ params: positionIdParams, body: updatePositionSchema })
  async update(
    @CurrentUser() user: CurrentUserContext,
    @Param("positionId", ParseIntPipe) positionId: number,
    @Body() body: UpdatePositionInput,
    @Req() req: Request,
  ) {
    return this.service.update(user.orgId, positionId, user.userId, user.isOrgOwner, body, req.ip);
  }

  @NoContentResponse()
  @Delete("positions/:positionId")
  @RequirePermission("hr:positions:manage")
  @HttpCode(204)
  @Validate({ params: positionIdParams })
  async softDelete(
    @CurrentUser() user: CurrentUserContext,
    @Param("positionId", ParseIntPipe) positionId: number,
    @Req() req: Request,
  ) {
    await this.service.softDelete(user.orgId, positionId, user.userId, req.ip);
  }

  @ResponseSchema(assignPositionResponseSchema)
  @Post("positions/:positionId/assign")
  @RequirePermission("hr:positions:manage")
  @Validate({ params: positionIdParams, body: assignPositionSchema })
  async assignEmployee(
    @CurrentUser() user: CurrentUserContext,
    @Param("positionId", ParseIntPipe) positionId: number,
    @Body() body: AssignPositionInput,
    @Req() req: Request,
  ) {
    return this.service.assignEmployee(user.orgId, positionId, user.userId, user.isOrgOwner, body, req.ip);
  }

  @ResponseSchema(listScenariosResponseSchema)
  @Get("scenarios")
  @RequirePermission("hr:positions:view")
  @Validate({ query: listScenariosSchema })
  async listScenarios(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ListScenariosInput,
  ) {
    return this.service.listScenarios(user.orgId, query);
  }

  @ResponseSchema(createScenarioResponseSchema)
  @Post("scenarios")
  @RequirePermission("hr:positions:manage")
  @Validate({ body: createReorgScenarioSchema })
  async createScenario(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: CreateReorgScenarioInput,
    @Req() req: Request,
  ) {
    return this.service.createScenario(user.orgId, user.userId, body, req.ip);
  }

  @ResponseSchema(updateScenarioResponseSchema)
  @Patch("scenarios/:scenarioId")
  @RequirePermission("hr:positions:manage")
  @Validate({ params: scenarioIdParams, body: updateReorgScenarioSchema })
  async updateScenario(
    @CurrentUser() user: CurrentUserContext,
    @Param("scenarioId", ParseIntPipe) scenarioId: number,
    @Body() body: UpdateReorgScenarioInput,
    @Req() req: Request,
  ) {
    return this.service.updateScenario(user.orgId, scenarioId, user.userId, body, req.ip);
  }

  @NoContentResponse()
  @Delete("scenarios/:scenarioId")
  @RequirePermission("hr:positions:manage")
  @HttpCode(204)
  @Validate({ params: scenarioIdParams })
  async deleteScenario(
    @CurrentUser() user: CurrentUserContext,
    @Param("scenarioId", ParseIntPipe) scenarioId: number,
    @Req() req: Request,
  ) {
    await this.service.deleteScenario(user.orgId, scenarioId, user.userId, req.ip);
  }

  @ResponseSchema(simulateScenarioResponseSchema)
  @Get("scenarios/:scenarioId/simulate")
  @RequirePermission("hr:positions:view")
  @Validate({ params: scenarioIdParams })
  async simulateScenario(
    @CurrentUser() user: CurrentUserContext,
    @Param("scenarioId", ParseIntPipe) scenarioId: number,
  ) {
    return this.service.simulateScenario(user.orgId, scenarioId);
  }
}
