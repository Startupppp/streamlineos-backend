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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PayrollPoliciesService } from "./policies.service";
import {
  createPolicySchema,
  updatePolicySchema,
  policyPreviewSchema,
  activatePolicySchema,
  createPolicyVersionSchema,
  toggleImpactSchema,
  type CreatePolicyInput,
  type UpdatePolicyInput,
  type PolicyPreviewInput,
  type ActivatePolicyInput,
  type CreatePolicyVersionInput,
  type ToggleImpactInput,
} from "./dto/setup.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const policyIdParams = z.object({ policyId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("payroll/policies")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayrollPoliciesController {
  constructor(private readonly service: PayrollPoliciesService) {}

  @Get("current")
  @RequirePermission("payroll:policies:view")
  async getCurrent(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return this.service.getCurrent(u.orgId);
  }

  @Get("toggle-impact")
  @RequirePermission("payroll:policies:view")
  async toggleImpact(
    @Query(new ZodValidationPipe(toggleImpactSchema)) query: ToggleImpactInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.toggleImpact(u.orgId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("payroll:policies:manage")
  async create(
    @Body(new ZodValidationPipe(createPolicySchema)) body: CreatePolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.create(u, body);
  }

  @Post("preview")
  @RequirePermission("payroll:policies:view")
  async preview(
    @Body(new ZodValidationPipe(policyPreviewSchema)) body: PolicyPreviewInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.preview(u.orgId, body);
  }

  @Patch(":policyId")
  @RequirePermission("payroll:policies:manage")
  @Validate({ params: policyIdParams })
  async update(
    @Param("policyId", ParseIntPipe) policyId: number,
    @Body(new ZodValidationPipe(updatePolicySchema)) body: UpdatePolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.update(u, policyId, body);
  }

  @Post(":policyId/activate")
  @HttpCode(200)
  @RequirePermission("payroll:policies:manage")
  @Validate({ params: policyIdParams })
  async activate(
    @Param("policyId", ParseIntPipe) policyId: number,
    @Body(new ZodValidationPipe(activatePolicySchema)) body: ActivatePolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.activate(u, policyId, body);
  }

  @Get(":policyId/versions")
  @RequirePermission("payroll:policies:view")
  @Validate({ params: policyIdParams })
  async listVersions(
    @Param("policyId", ParseIntPipe) policyId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.listVersions(u.orgId, policyId);
  }

  @Post(":policyId/versions")
  @HttpCode(201)
  @RequirePermission("payroll:policies:manage")
  @Validate({ params: policyIdParams })
  async createVersion(
    @Param("policyId", ParseIntPipe) policyId: number,
    @Body(new ZodValidationPipe(createPolicyVersionSchema)) body: CreatePolicyVersionInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.createVersion(u, policyId, body);
  }
}
