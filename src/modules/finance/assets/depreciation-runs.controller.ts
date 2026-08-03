import {
  Body, Controller, Get, HttpCode, Param, ParseIntPipe,
  Post, Query, UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { DepreciationRunsService } from "./depreciation-runs.service";
import {
  createRunSchema, listRunsQuerySchema,
  type CreateRunInput, type ListRunsQuery,
} from "./dto/assets.schemas";

@RequireModule("accounting")
@Controller("accounting/assets/depreciation/runs")
@UseGuards(JwtAuthGuard)
export class DepreciationRunsController {
  constructor(private readonly runs: DepreciationRunsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:read")
  list(
    @Query(new ZodValidationPipe(listRunsQuerySchema)) query: ListRunsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.runs.list(u.orgId, query);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:manage")
  @HttpCode(201)
  @Idempotent("accounting.depreciation-run.execute")
  create(
    @Body(new ZodValidationPipe(createRunSchema)) body: CreateRunInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.runs.runDepreciation(u, body.periodKey);
  }

  @Post(":runId/reverse")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:manage")
  @HttpCode(200)
  @Idempotent("accounting.depreciation-run.reverse")
  reverse(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.runs.reverseRun(u, runId);
  }
}
