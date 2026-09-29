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
  createTestSuiteSchema,
  testSuiteListQuerySchema,
  updateTestSuiteSchema,
  type CreateTestSuiteInput,
  type TestSuiteListQuery,
  type UpdateTestSuiteInput,
} from "./dto/qa.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { successSchema } from "../../../common/openapi/response-envelopes";
import { z } from "zod";
import { BodylessAction, NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { testSuiteWithCaseCountSchema } from "./dto/qa-response.schemas";

export const suiteIdParams = z.object({ projectId: z.coerce.number().int().positive(), suiteId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build/:projectId/test-suites")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TestSuitesController {
  constructor(private readonly svc: TestManagementService) {}

  @Get()
  @RequirePermission("build:qa:view")
  @ResponseSchema(z.array(testSuiteWithCaseCountSchema))
  @Validate({ query: testSuiteListQuerySchema })
  listSuites(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: TestSuiteListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listSuites(u, projectId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:qa:manage")
  @ResponseSchema(testSuiteWithCaseCountSchema)
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
  @ResponseSchema(testSuiteWithCaseCountSchema)
  @Validate({ params: suiteIdParams, body: updateTestSuiteSchema })
  updateSuite(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("suiteId", ParseIntPipe) suiteId: number,
    @Body() body: UpdateTestSuiteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateSuite(u, projectId, suiteId, body);
  }

  @Delete(":suiteId")
  @RequirePermission("build:qa:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: suiteIdParams })
  deleteSuite(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("suiteId", ParseIntPipe) suiteId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteSuite(u, projectId, suiteId);
  }

  @Post(":suiteId/restore")
  @RequirePermission("build:qa:restore")
  @BodylessAction()
  @ResponseSchema(successSchema)
  @Validate({ params: suiteIdParams })
  restoreSuite(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("suiteId", ParseIntPipe) suiteId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.restoreSuite(u, projectId, suiteId);
  }
}
