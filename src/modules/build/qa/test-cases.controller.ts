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
import { TestManagementService } from "./test-management.service";
import {
  createTestCaseSchema,
  testCaseListQuerySchema,
  updateTestCaseSchema,
  type CreateTestCaseInput,
  type TestCaseListQuery,
  type UpdateTestCaseInput,
} from "./dto/qa.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const caseIdParams = z.object({ caseId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build/:projectId/test-cases")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TestCasesController {
  constructor(private readonly svc: TestManagementService) {}

  @Get()
  @RequirePermission("build:qa:view")
  @Validate({ query: testCaseListQuerySchema })
  listCases(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: TestCaseListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listCases(u, projectId, query);
  }

  @Get(":caseId")
  @RequirePermission("build:qa:view")
  @Validate({ params: caseIdParams })
  getCase(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("caseId", ParseIntPipe) caseId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getCase(u.orgId, projectId, caseId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:qa:manage")
  @Validate({ body: createTestCaseSchema })
  createCase(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateTestCaseInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createCase(u, projectId, body);
  }

  @Patch(":caseId")
  @RequirePermission("build:qa:manage")
  @Validate({ params: caseIdParams, body: updateTestCaseSchema })
  updateCase(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("caseId", ParseIntPipe) caseId: number,
    @Body() body: UpdateTestCaseInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateCase(u.orgId, projectId, caseId, body);
  }

  @Delete(":caseId")
  @RequirePermission("build:qa:manage")
  @HttpCode(204)
  @Validate({ params: caseIdParams })
  deleteCase(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("caseId", ParseIntPipe) caseId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteCase(u.orgId, projectId, caseId);
  }
}
