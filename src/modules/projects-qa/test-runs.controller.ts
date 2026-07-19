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
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
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

@RequireModule("projects")
@Controller("projects/:projectId/test-runs")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TestRunsController {
  constructor(private readonly svc: TestRunsService) {}

  @Get()
  @RequirePermission("projects:qa:view")
  listRuns(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query(new ZodValidationPipe(testRunListQuerySchema)) query: TestRunListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listRuns(u.orgId, projectId, query);
  }

  @Get(":runId")
  @RequirePermission("projects:qa:view")
  getRun(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getRun(u.orgId, projectId, runId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("projects:qa:manage")
  createRun(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createTestRunSchema)) body: CreateTestRunInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createRun(u.orgId, u.userId, projectId, body);
  }

  @Patch(":runId")
  @RequirePermission("projects:qa:manage")
  updateRun(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("runId", ParseIntPipe) runId: number,
    @Body(new ZodValidationPipe(updateTestRunSchema)) body: UpdateTestRunInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateRun(u.orgId, u.userId, projectId, runId, body);
  }

  @Delete(":runId")
  @RequirePermission("projects:qa:manage")
  @HttpCode(204)
  deleteRun(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteRun(u.orgId, projectId, runId);
  }

  @Patch(":runId/results/:resultId")
  @RequirePermission("projects:qa:execute")
  updateResult(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("runId", ParseIntPipe) runId: number,
    @Param("resultId", ParseIntPipe) resultId: number,
    @Body(new ZodValidationPipe(updateTestResultSchema)) body: UpdateTestResultInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateResult(u.orgId, projectId, runId, resultId, body, u.userId);
  }

  @Post(":runId/results/:resultId/bug")
  @HttpCode(201)
  @RequirePermission("projects:bugs:create")
  createBugFromResult(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("runId", ParseIntPipe) runId: number,
    @Param("resultId", ParseIntPipe) resultId: number,
    @Body(new ZodValidationPipe(createBugFromResultSchema)) body: CreateBugFromResultInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createBugFromResult(u.orgId, u.userId, projectId, runId, resultId, body);
  }
}
