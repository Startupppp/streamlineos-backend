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
  createTestSuiteSchema,
  updateTestSuiteSchema,
  type CreateTestSuiteInput,
  type UpdateTestSuiteInput,
} from "./dto/qa.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const suiteIdParams = z.object({ suiteId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build/:projectId/test-suites")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TestSuitesController {
  constructor(private readonly svc: TestManagementService) {}

  @Get()
  @RequirePermission("build:qa:view")
  listSuites(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listSuites(u, projectId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:qa:manage")
  @Validate({ body: createTestSuiteSchema })
  createSuite(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateTestSuiteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createSuite(u, projectId, body);
  }

  @Patch(":suiteId")
  @RequirePermission("build:qa:manage")
  @Validate({ params: suiteIdParams, body: updateTestSuiteSchema })
  updateSuite(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("suiteId", ParseIntPipe) suiteId: number,
    @Body() body: UpdateTestSuiteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateSuite(u.orgId, projectId, suiteId, body);
  }

  @Delete(":suiteId")
  @RequirePermission("build:qa:manage")
  @HttpCode(204)
  @Validate({ params: suiteIdParams })
  deleteSuite(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("suiteId", ParseIntPipe) suiteId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteSuite(u.orgId, projectId, suiteId);
  }
}
