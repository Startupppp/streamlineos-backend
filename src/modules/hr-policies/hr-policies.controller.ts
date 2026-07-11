import {
  Body,
  Controller,
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
import { HrPoliciesService } from "./hr-policies.service";
import {
  createPolicySchema,
  policiesListQuerySchema,
  previewQuerySchema,
  updatePolicySchema,
  type CreatePolicyInput,
  type PoliciesListQuery,
  type PreviewQuery,
  type UpdatePolicyInput,
} from "./dto/hr-policy.schemas";
import type { PolicyType } from "./hr-policy-types";

@RequireModule("hr")
@Controller("hr/policies")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrPoliciesController {
  constructor(private readonly service: HrPoliciesService) {}

  @Get()
  @RequirePermission("hr:policies:view")
  list(
    @Query(new ZodValidationPipe(policiesListQuerySchema)) query: PoliciesListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u.orgId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:policies:manage")
  create(
    @Body(new ZodValidationPipe(createPolicySchema)) body: CreatePolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }

  @Get("seed-defaults")
  @RequirePermission("hr:policies:manage")
  getSeedStatus(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId, { page: 1, limit: 1 });
  }

  @Post("seed-defaults")
  @HttpCode(201)
  @RequirePermission("hr:policies:manage")
  seedDefaults(@CurrentUser() u: CurrentUserContext) {
    return this.service.seedDefaults(u.orgId, u.userId);
  }

  @Get(":policyId")
  @RequirePermission("hr:policies:view")
  getById(
    @Param("policyId", ParseIntPipe) policyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getById(u.orgId, policyId);
  }

  @Patch(":policyId")
  @RequirePermission("hr:policies:manage")
  update(
    @Param("policyId", ParseIntPipe) policyId: number,
    @Body(new ZodValidationPipe(updatePolicySchema)) body: UpdatePolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.update(u.orgId, policyId, body);
  }

  @Post(":policyId/versions")
  @HttpCode(201)
  @RequirePermission("hr:policies:manage")
  createVersion(
    @Param("policyId", ParseIntPipe) policyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createVersion(u.orgId, u.userId, policyId);
  }

  @Post(":policyId/activate")
  @RequirePermission("hr:policies:manage")
  activate(
    @Param("policyId", ParseIntPipe) policyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.activate(u.orgId, policyId);
  }

  @Post(":policyId/archive")
  @RequirePermission("hr:policies:manage")
  archive(
    @Param("policyId", ParseIntPipe) policyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.archive(u.orgId, policyId);
  }

  @Get(":policyId/preview")
  @RequirePermission("hr:policies:view")
  async preview(
    @Param("policyId", ParseIntPipe) _policyId: number,
    @Query(new ZodValidationPipe(previewQuerySchema)) query: PreviewQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const policy = await this.service.getById(u.orgId, _policyId);
    return this.service.preview(
      u.orgId,
      query.employeeId,
      policy.policyType as PolicyType,
      query.date,
    );
  }
}
