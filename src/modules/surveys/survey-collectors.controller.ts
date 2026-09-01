import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { SurveyCollectorService } from "./survey-collector.service";
import {
  createCollectorSchema,
  patchCollectorSchema,
  type CreateCollectorInput,
  type PatchCollectorInput,
} from "./dto/survey-collectors.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const surveyIdParams = z.object({ surveyId: z.coerce.number().int().positive() }).strict();
const surveyAndCollectorIdParams = z.object({ surveyId: z.coerce.number().int().positive(), collectorId: z.coerce.number().int().positive() }).strict();

@RequireModule("surveys")
@Controller("surveys/:surveyId/collectors")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SurveyCollectorsController {
  constructor(private readonly collectors: SurveyCollectorService) {}

  @Get()
  @RequirePermission("surveys:participants:view")
  @Validate({ params: surveyIdParams })
  list(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    return this.collectors.list(u.orgId, surveyId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("surveys:participants:manage")
  @Validate({ params: surveyIdParams, body: createCollectorSchema })
  create(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body() body: CreateCollectorInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.collectors.create(u.orgId, surveyId, body);
  }

  @Patch(":collectorId")
  @RequirePermission("surveys:participants:manage")
  @Validate({ params: surveyAndCollectorIdParams, body: patchCollectorSchema })
  patch(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Param("collectorId", ParseIntPipe) collectorId: number,
    @Body() body: PatchCollectorInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.collectors.patch(u.orgId, surveyId, collectorId, body);
  }
}
