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
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { HrPoliciesService } from "./hr-policies.service";
import {
  createPolicySchema,
  HR_POLICY_TYPES,
  policiesListQuerySchema,
  previewQuerySchema,
  updatePolicySchema,
  type CreatePolicyInput,
  type PoliciesListQuery,
  type PreviewQuery,
  type UpdatePolicyInput,
} from "./dto/hr-policy.schemas";
import type { PolicyType } from "./hr-policy-types";
import { Validate } from "../../../common/validation/validate.decorator";

const policyIdParams = z.object({ policyId: z.coerce.number().int().positive() }).strict();

const activatePolicySchema = z.object({
  force: z.boolean().optional().default(false),
});

const simulatePolicySchema = z.object({
  employeeId: z.string().min(1),
  policyType: z.enum(HR_POLICY_TYPES),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rules: z.record(z.string(), z.unknown()).optional(),
});

const orgConflictsQuerySchema = z.object({
  type: z.enum(HR_POLICY_TYPES).optional(),
});

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

  @Get("conflicts")
  @RequirePermission("hr:policies:view")
  orgConflicts(
    @Query(new ZodValidationPipe(orgConflictsQuerySchema))
    query: z.infer<typeof orgConflictsQuerySchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.detectOrgConflicts(u.orgId, query.type);
  }

  @Post("simulate")
  @HttpCode(200)
  @RequirePermission("hr:policies:view")
  simulate(
    @Body(new ZodValidationPipe(simulatePolicySchema))
    body: z.infer<typeof simulatePolicySchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.simulate(u.orgId, {
      employeeId: body.employeeId,
      policyType: body.policyType as PolicyType,
      date: body.date,
      rules: body.rules,
    });
  }

  @Get(":policyId")
  @RequirePermission("hr:policies:view")
  @Validate({ params: policyIdParams })
  getById(
    @Param("policyId", ParseIntPipe) policyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getById(u.orgId, policyId);
  }

  @Patch(":policyId")
  @RequirePermission("hr:policies:manage")
  @Validate({ params: policyIdParams })
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
  @Validate({ params: policyIdParams })
  createVersion(
    @Param("policyId", ParseIntPipe) policyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createVersion(u.orgId, u.userId, policyId);
  }

  @Post(":policyId/activate")
  @HttpCode(200)
  @RequirePermission("hr:policies:manage")
  @Validate({ params: policyIdParams })
  activate(
    @Param("policyId", ParseIntPipe) policyId: number,
    @Body(new ZodValidationPipe(activatePolicySchema))
    body: z.infer<typeof activatePolicySchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.activate(u.orgId, policyId, { force: body.force });
  }

  @Get(":policyId/conflicts")
  @RequirePermission("hr:policies:view")
  @Validate({ params: policyIdParams })
  conflicts(
    @Param("policyId", ParseIntPipe) policyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.detectConflicts(u.orgId, policyId);
  }

  @Post(":policyId/archive")
  @HttpCode(200)
  @RequirePermission("hr:policies:manage")
  @Validate({ params: policyIdParams })
  archive(
    @Param("policyId", ParseIntPipe) policyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.archive(u.orgId, policyId);
  }

  @Get(":policyId/preview")
  @RequirePermission("hr:policies:view")
  @Validate({ params: policyIdParams })
  async preview(
    @Param("policyId", ParseIntPipe) policyId: number,
    @Query(new ZodValidationPipe(previewQuerySchema)) query: PreviewQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const policy = await this.service.getById(u.orgId, policyId);
    return this.service.preview(
      u.orgId,
      query.employeeId,
      policy.policyType as PolicyType,
      query.date,
    );
  }
}
