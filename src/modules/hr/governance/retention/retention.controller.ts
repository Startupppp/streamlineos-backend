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
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { RetentionService } from "./retention.service";
import {
  createRetentionPolicySchema,
  updateRetentionPolicySchema,
  listRetentionPoliciesSchema,
  createDataRequestSchema,
  updateDataRequestSchema,
  listDataRequestsSchema,
  type CreateRetentionPolicyInput,
  type UpdateRetentionPolicyInput,
  type ListRetentionPoliciesInput,
  type CreateDataRequestInput,
  type UpdateDataRequestInput,
  type ListDataRequestsInput,
} from "./retention.dto";
import { Idempotent } from "../../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema, NoContentResponse } from "../../../../common/openapi/zod-operation-contracts";
import { listRetentionPoliciesResponseSchema, createRetentionPolicyResponseSchema, updateRetentionPolicyResponseSchema, listDataRequestsResponseSchema, createDataRequestResponseSchema, updateDataRequestResponseSchema, approveDataRequestResponseSchema, processDataRequestResponseSchema } from "../dto/governance-response.schemas"

const policyIdParams = z.object({ policyId: z.coerce.number().int().positive() }).strict();
const requestIdParams = z.object({ requestId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/governance/retention")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RetentionController {
  constructor(private readonly service: RetentionService) {}

  @ResponseSchema(listRetentionPoliciesResponseSchema)
  @Get("policies")
  @RequirePermission("hr:retention:manage")
  @Validate({ query: listRetentionPoliciesSchema })
  async listPolicies(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ListRetentionPoliciesInput,
  ) {
    return this.service.listPolicies(user.orgId, query);
  }

  @ResponseSchema(createRetentionPolicyResponseSchema)
  @Post("policies")
  @RequirePermission("hr:retention:manage")
  @Validate({ body: createRetentionPolicySchema })
  async createPolicy(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: CreateRetentionPolicyInput,
    @Req() req: Request,
  ) {
    return this.service.createPolicy(user.orgId, user.userId, body, req.ip);
  }

  @ResponseSchema(updateRetentionPolicyResponseSchema)
  @Patch("policies/:policyId")
  @RequirePermission("hr:retention:manage")
  @Validate({ params: policyIdParams, body: updateRetentionPolicySchema })
  async updatePolicy(
    @CurrentUser() user: CurrentUserContext,
    @Param("policyId", ParseIntPipe) policyId: number,
    @Body() body: UpdateRetentionPolicyInput,
    @Req() req: Request,
  ) {
    return this.service.updatePolicy(user.orgId, policyId, user.userId, body, req.ip);
  }

  @NoContentResponse()
  @Delete("policies/:policyId")
  @RequirePermission("hr:retention:manage")
  @HttpCode(204)
  @Validate({ params: policyIdParams })
  async deletePolicy(
    @CurrentUser() user: CurrentUserContext,
    @Param("policyId", ParseIntPipe) policyId: number,
    @Req() req: Request,
  ) {
    await this.service.deletePolicy(user.orgId, policyId, user.userId, req.ip);
  }

  @ResponseSchema(listDataRequestsResponseSchema)
  @Get("requests")
  @RequirePermission("hr:retention:manage")
  @Validate({ query: listDataRequestsSchema })
  async listRequests(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ListDataRequestsInput,
  ) {
    return this.service.listRequests(user.orgId, query);
  }

  @ResponseSchema(createDataRequestResponseSchema)
  @Post("requests")
  @RequirePermission("hr:retention:manage")
  @Validate({ body: createDataRequestSchema })
  async createRequest(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: CreateDataRequestInput,
    @Req() req: Request,
  ) {
    return this.service.createRequest(user.orgId, user.userId, body, req.ip);
  }

  @ResponseSchema(updateDataRequestResponseSchema)
  @Patch("requests/:requestId")
  @RequirePermission("hr:retention:manage")
  @Validate({ params: requestIdParams, body: updateDataRequestSchema })
  async updateRequest(
    @CurrentUser() user: CurrentUserContext,
    @Param("requestId", ParseIntPipe) requestId: number,
    @Body() body: UpdateDataRequestInput,
    @Req() req: Request,
  ) {
    return this.service.updateRequest(user.orgId, requestId, user.userId, body, req.ip);
  }

  @ResponseSchema(approveDataRequestResponseSchema)
  @Post("requests/:requestId/approve")
  @BodylessAction()
  @Idempotent("hr.retention.approve")
  @RequirePermission("hr:retention:manage")
  @Validate({ params: requestIdParams })
  async approveRequest(
    @CurrentUser() user: CurrentUserContext,
    @Param("requestId", ParseIntPipe) requestId: number,
    @Req() req: Request,
  ) {
    return this.service.approveRequest(user.orgId, requestId, user.userId, req.ip);
  }

  @ResponseSchema(processDataRequestResponseSchema)
  @Post("requests/:requestId/process")
  @BodylessAction()
  @RequirePermission("hr:retention:manage")
  @Validate({ params: requestIdParams })
  async processRequest(
    @CurrentUser() user: CurrentUserContext,
    @Param("requestId", ParseIntPipe) requestId: number,
    @Req() req: Request,
  ) {
    return this.service.processRequest(user.orgId, requestId, user.userId, req.ip);
  }
}
