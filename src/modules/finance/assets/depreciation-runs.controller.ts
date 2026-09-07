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
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { DepreciationRunsService } from "./depreciation-runs.service";
import {
  createRunSchema, listRunsQuerySchema,
  type CreateRunInput, type ListRunsQuery,
} from "./dto/assets.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  depreciationRunListResponseSchema,
  depreciationRunCreateResponseSchema,
  depreciationRunReverseResponseSchema,
} from "./dto/assets-response.schemas";

const runIdParams = z.object({ runId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/assets/depreciation/runs")
@UseGuards(JwtAuthGuard)
export class DepreciationRunsController {
  constructor(private readonly runs: DepreciationRunsService) {}

  @Get()
  @ResponseSchema(depreciationRunListResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:read")
  @Validate({ query: listRunsQuerySchema })
  list(
    @Query() query: ListRunsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.runs.list(u.orgId, query);
  }

  @Post()
  @ResponseSchema(depreciationRunCreateResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:manage")
  @HttpCode(201)
  @Idempotent("accounting.depreciation-run.execute")
  @Validate({ body: createRunSchema })
  create(
    @Body() body: CreateRunInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.runs.runDepreciation(u, body.periodKey);
  }

  @Post(":runId/reverse")
  @BodylessAction()
  @ResponseSchema(depreciationRunReverseResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:manage")
  @HttpCode(200)
  @Idempotent("accounting.depreciation-run.reverse")
  @Validate({ params: runIdParams })
  reverse(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.runs.reverseRun(u, runId);
  }
}
