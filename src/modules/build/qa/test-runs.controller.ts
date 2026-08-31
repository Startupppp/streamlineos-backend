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
import { TestRunsService } from "./test-runs.service";
import {
  createBugFromResultSchema,
  createTestRunSchema,
  testRunListQuerySchema,
  updateTestResultSchema,
  updateTestRunSchema,
  type CreateBugFromResultInput,
  type CreateTestRunInput,
  type TestRunListQuery,
  type UpdateTestResultInput,
  type UpdateTestRunInput,
} from "./dto/qa.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const runIdParams = z.object({ runId: z.coerce.number().int().positive() }).strict();
const runIdresultIdParams = z.object({ runId: z.coerce.number().int().positive(), resultId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build/:projectId/test-runs")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TestRunsController {
  constructor(private readonly svc: TestRunsService) {}

  @Get()
  @RequirePermission("build:qa:view")
  @Validate({ query: testRunListQuerySchema })
  listRuns(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: TestRunListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listRuns(u.orgId, projectId, query);
  }

  @Get(":runId")
  @RequirePermission("build:qa:view")
  @Validate({ params: runIdParams })
  getRun(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getRun(u.orgId, projectId, runId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:qa:manage")
  @Validate({ body: createTestRunSchema })
  createRun(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateTestRunInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createRun(u.orgId, u.userId, projectId, body);
  }

  @Patch(":runId")
  @RequirePermission("build:qa:manage")
  @Validate({ params: runIdParams, body: updateTestRunSchema })
  updateRun(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("runId", ParseIntPipe) runId: number,
    @Body() body: UpdateTestRunInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateRun(u.orgId, u.userId, projectId, runId, body);
  }

  @Delete(":runId")
  @RequirePermission("build:qa:manage")
  @HttpCode(204)
  @Validate({ params: runIdParams })
  deleteRun(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteRun(u.orgId, projectId, runId);
  }

  @Patch(":runId/results/:resultId")
  @RequirePermission("build:qa:execute")
  @Validate({ params: runIdresultIdParams, body: updateTestResultSchema })
  updateResult(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("runId", ParseIntPipe) runId: number,
    @Param("resultId", ParseIntPipe) resultId: number,
    @Body() body: UpdateTestResultInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateResult(u.orgId, projectId, runId, resultId, body, u.userId);
  }

  @Post(":runId/results/:resultId/bug")
  @HttpCode(201)
  @RequirePermission("build:bugs:create")
  @Validate({ params: runIdresultIdParams, body: createBugFromResultSchema })
  createBugFromResult(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("runId", ParseIntPipe) runId: number,
    @Param("resultId", ParseIntPipe) resultId: number,
    @Body() body: CreateBugFromResultInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createBugFromResult(u.orgId, u.userId, projectId, runId, resultId, body);
  }
}
