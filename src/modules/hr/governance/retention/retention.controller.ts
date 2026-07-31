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
import { ZodValidationPipe } from "../../../../common/pipes/zod-validation.pipe";
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

@RequireModule("hr")
@Controller("hr/governance/retention")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RetentionController {
  constructor(private readonly service: RetentionService) {}

  @Get("policies")
  @RequirePermission("hr:retention:manage")
  async listPolicies(
    @CurrentUser() user: CurrentUserContext,
    @Query(new ZodValidationPipe(listRetentionPoliciesSchema)) query: ListRetentionPoliciesInput,
  ) {
    return this.service.listPolicies(user.orgId, query);
  }

  @Post("policies")
  @RequirePermission("hr:retention:manage")
  async createPolicy(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(createRetentionPolicySchema)) body: CreateRetentionPolicyInput,
    @Req() req: Request,
  ) {
    return this.service.createPolicy(user.orgId, user.userId, body, req.ip);
  }

  @Patch("policies/:policyId")
  @RequirePermission("hr:retention:manage")
  async updatePolicy(
    @CurrentUser() user: CurrentUserContext,
    @Param("policyId", ParseIntPipe) policyId: number,
    @Body(new ZodValidationPipe(updateRetentionPolicySchema)) body: UpdateRetentionPolicyInput,
    @Req() req: Request,
  ) {
    return this.service.updatePolicy(user.orgId, policyId, user.userId, body, req.ip);
  }

  @Delete("policies/:policyId")
  @RequirePermission("hr:retention:manage")
  @HttpCode(204)
  async deletePolicy(
    @CurrentUser() user: CurrentUserContext,
    @Param("policyId", ParseIntPipe) policyId: number,
    @Req() req: Request,
  ) {
    await this.service.deletePolicy(user.orgId, policyId, user.userId, req.ip);
  }

  @Get("requests")
  @RequirePermission("hr:retention:manage")
  async listRequests(
    @CurrentUser() user: CurrentUserContext,
    @Query(new ZodValidationPipe(listDataRequestsSchema)) query: ListDataRequestsInput,
  ) {
    return this.service.listRequests(user.orgId, query);
  }

  @Post("requests")
  @RequirePermission("hr:retention:manage")
  async createRequest(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(createDataRequestSchema)) body: CreateDataRequestInput,
    @Req() req: Request,
  ) {
    return this.service.createRequest(user.orgId, user.userId, body, req.ip);
  }

  @Patch("requests/:requestId")
  @RequirePermission("hr:retention:manage")
  async updateRequest(
    @CurrentUser() user: CurrentUserContext,
    @Param("requestId", ParseIntPipe) requestId: number,
    @Body(new ZodValidationPipe(updateDataRequestSchema)) body: UpdateDataRequestInput,
    @Req() req: Request,
  ) {
    return this.service.updateRequest(user.orgId, requestId, user.userId, body, req.ip);
  }

  @Post("requests/:requestId/approve")
  @RequirePermission("hr:retention:manage")
  async approveRequest(
    @CurrentUser() user: CurrentUserContext,
    @Param("requestId", ParseIntPipe) requestId: number,
    @Req() req: Request,
  ) {
    return this.service.approveRequest(user.orgId, requestId, user.userId, req.ip);
  }

  @Post("requests/:requestId/process")
  @RequirePermission("hr:retention:manage")
  async processRequest(
    @CurrentUser() user: CurrentUserContext,
    @Param("requestId", ParseIntPipe) requestId: number,
    @Req() req: Request,
  ) {
    return this.service.processRequest(user.orgId, requestId, user.userId, req.ip);
  }
}
