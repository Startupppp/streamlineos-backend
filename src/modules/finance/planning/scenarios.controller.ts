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
import { ScenariosService } from "./scenarios.service";
import { ForecastService } from "./forecast.service";
import {
  createScenarioSchema, updateScenarioSchema, forecastQuerySchema, compareScenariosQuerySchema,
  type CreateScenarioInput, type UpdateScenarioInput, type ForecastQuery, type CompareScenariosQuery,
} from "./dto/finance-planning.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const scenarioIdParams = z.object({ scenarioId: z.coerce.number().int().positive() }).strict();

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
  @Validate({ body: createScenarioSchema })
  createScenario(
    @Body() body: CreateScenarioInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scenarios.createScenario(u.orgId, u.userId, body);
  }

  @Patch("scenarios/:scenarioId")
  @RequirePermission("accounting:forecast:manage")
  @Validate({ params: scenarioIdParams, body: updateScenarioSchema })
  updateScenario(
    @Param("scenarioId", ParseIntPipe) scenarioId: number,
    @Body() body: UpdateScenarioInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scenarios.updateScenario(u.orgId, scenarioId, u.userId, body);
  }

  @Delete("scenarios/:scenarioId")
  @RequirePermission("accounting:forecast:manage")
  @HttpCode(204)
  @Validate({ params: scenarioIdParams })
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
  @Validate({ query: forecastQuerySchema })
  getForecast(
    @Query() query: ForecastQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.forecast.getForecast(u.orgId, query);
  }

  @Get("forecast/compare")
  @RequirePermission("accounting:forecast:read")
  @Validate({ query: compareScenariosQuerySchema })
  compareForecast(
    @Query() query: CompareScenariosQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.forecast.compareForecast(u.orgId, query, u.userId);
  }
}
