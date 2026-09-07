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
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  hrPolicyRowSchema,
  hrPolicyListSchema,
  hrPolicySeedResultSchema,
  hrPolicyConflictsSchema,
  hrPolicyOrgConflictsSchema,
  hrPolicySimulateSchema,
  hrPolicyPreviewSchema,
  successSchema,
} from "./dto/policies-response.schemas";

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
  @ResponseSchema(hrPolicyListSchema)
  @RequirePermission("hr:policies:view")
  @Validate({ query: policiesListQuerySchema })
  list(
    @Query() query: PoliciesListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u.orgId, query);
  }

  @Post()
  @ResponseSchema(hrPolicyRowSchema)
  @HttpCode(201)
  @RequirePermission("hr:policies:manage")
  @Validate({ body: createPolicySchema })
  create(
    @Body() body: CreatePolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }

  @Get("seed-defaults")
  @ResponseSchema(hrPolicyListSchema)
  @RequirePermission("hr:policies:manage")
  getSeedStatus(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId, { page: 1, limit: 1 });
  }

  @Post("seed-defaults")
  @ResponseSchema(hrPolicySeedResultSchema)
  @BodylessAction()
  @HttpCode(201)
  @RequirePermission("hr:policies:manage")
  seedDefaults(@CurrentUser() u: CurrentUserContext) {
    return this.service.seedDefaults(u.orgId, u.userId);
  }

  @Get("conflicts")
  @ResponseSchema(hrPolicyOrgConflictsSchema)
  @RequirePermission("hr:policies:view")
  @Validate({ query: orgConflictsQuerySchema })
  orgConflicts(
    @Query() query: z.infer<typeof orgConflictsQuerySchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.detectOrgConflicts(u.orgId, query.type);
  }

  @Post("simulate")
  @ResponseSchema(hrPolicySimulateSchema)
  @HttpCode(200)
  @RequirePermission("hr:policies:view")
  @Validate({ body: simulatePolicySchema })
  simulate(
    @Body() body: z.infer<typeof simulatePolicySchema>,
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
  @ResponseSchema(hrPolicyRowSchema)
  @RequirePermission("hr:policies:view")
  @Validate({ params: policyIdParams })
  getById(
    @Param("policyId", ParseIntPipe) policyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getById(u.orgId, policyId);
  }

  @Patch(":policyId")
  @ResponseSchema(hrPolicyRowSchema)
  @RequirePermission("hr:policies:manage")
  @Validate({ params: policyIdParams, body: updatePolicySchema })
  update(
    @Param("policyId", ParseIntPipe) policyId: number,
    @Body() body: UpdatePolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.update(u.orgId, policyId, body);
  }

  @Post(":policyId/versions")
  @ResponseSchema(hrPolicyRowSchema)
  @BodylessAction()
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
  @ResponseSchema(hrPolicyRowSchema)
  @HttpCode(200)
  @RequirePermission("hr:policies:manage")
  @Validate({ params: policyIdParams, body: activatePolicySchema })
  activate(
    @Param("policyId", ParseIntPipe) policyId: number,
    @Body() body: z.infer<typeof activatePolicySchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.activate(u.orgId, policyId, { force: body.force });
  }

  @Get(":policyId/conflicts")
  @ResponseSchema(hrPolicyConflictsSchema)
  @RequirePermission("hr:policies:view")
  @Validate({ params: policyIdParams })
  conflicts(
    @Param("policyId", ParseIntPipe) policyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.detectConflicts(u.orgId, policyId);
  }

  @Post(":policyId/archive")
  @ResponseSchema(successSchema)
  @BodylessAction()
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
  @ResponseSchema(hrPolicyPreviewSchema)
  @RequirePermission("hr:policies:view")
  @Validate({ params: policyIdParams, query: previewQuerySchema })
  async preview(
    @Param("policyId", ParseIntPipe) policyId: number,
    @Query() query: PreviewQuery,
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
