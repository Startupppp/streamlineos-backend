import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe,
  Patch, Post, Query, UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ScenariosService } from "./scenarios.service";
import { ForecastService } from "./forecast.service";
import {
  createScenarioSchema, updateScenarioSchema, forecastQuerySchema, compareScenariosQuerySchema,
  type CreateScenarioInput, type UpdateScenarioInput, type ForecastQuery, type CompareScenariosQuery,
} from "./dto/finance-planning.schemas";

@RequireModule("accounting")
@Controller("accounting")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ScenariosController {
  constructor(
    private readonly scenarios: ScenariosService,
    private readonly forecast: ForecastService,
  ) {}

  @Get("scenarios")
  @RequirePermission("accounting:forecast:read")
  listScenarios(@CurrentUser() u: CurrentUserContext) {
    return this.scenarios.listScenarios(u.orgId);
  }

  @Post("scenarios")
  @RequirePermission("accounting:forecast:manage")
  @HttpCode(201)
  createScenario(
    @Body(new ZodValidationPipe(createScenarioSchema)) body: CreateScenarioInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scenarios.createScenario(u.orgId, u.userId, body);
  }

  @Patch("scenarios/:scenarioId")
  @RequirePermission("accounting:forecast:manage")
  updateScenario(
    @Param("scenarioId", ParseIntPipe) scenarioId: number,
    @Body(new ZodValidationPipe(updateScenarioSchema)) body: UpdateScenarioInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scenarios.updateScenario(u.orgId, scenarioId, u.userId, body);
  }

  @Delete("scenarios/:scenarioId")
  @RequirePermission("accounting:forecast:manage")
  @HttpCode(204)
  deleteScenario(
    @Param("scenarioId", ParseIntPipe) scenarioId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scenarios.deleteScenario(u.orgId, scenarioId, u.userId);
  }

  @Post("scenarios/seed-defaults")
  @RequirePermission("accounting:forecast:manage")
  @HttpCode(200)
  seedDefaults(@CurrentUser() u: CurrentUserContext) {
    return this.scenarios.seedDefaults(u.orgId, u.userId);
  }

  @Get("forecast")
  @RequirePermission("accounting:forecast:read")
  getForecast(
    @Query(new ZodValidationPipe(forecastQuerySchema)) query: ForecastQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.forecast.getForecast(u.orgId, query);
  }

  @Get("forecast/compare")
  @RequirePermission("accounting:forecast:read")
  compareForecast(
    @Query(new ZodValidationPipe(compareScenariosQuerySchema)) query: CompareScenariosQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.forecast.compareForecast(u.orgId, query, u.userId);
  }
}
