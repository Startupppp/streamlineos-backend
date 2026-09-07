import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { wireDate } from "../../../common/openapi/wire-types";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { HrSettingsHubService } from "./hr-settings-hub.service";
import { effectiveRulesQuerySchema, versionsQuerySchema } from "./dto/hr-settings-hub.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import type { EffectiveRulesQuery, VersionsQuery } from "./dto/hr-settings-hub.schemas";

const policyEvaluationTraceSchema = z.object({
  policyId: z.number().int(),
  policyName: z.string(),
  version: z.number().int(),
  matchedScopes: z.array(z.object({ scopeType: z.string(), scopeValue: z.string(), specificity: z.number() })),
  maxSpecificity: z.number(),
  priority: z.number().int(),
});

const effectiveRulesItemSchema = z.object({
  policyType: z.string(),
  matchedPolicy: z.object({
    id: z.number().int(),
    name: z.string(),
    policyType: z.string(),
    version: z.number().int(),
    status: z.string(),
    effectiveFrom: z.string(),
    effectiveTo: z.string().nullable(),
    priority: z.number().int(),
    rules: z.record(z.string(), z.unknown()),
  }),
  rules: z.record(z.string(), z.unknown()),
  trace: policyEvaluationTraceSchema,
});

const effectiveRulesResponseSchema = z.array(effectiveRulesItemSchema);

const policyVersionItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  version: z.number().int(),
  status: z.string(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  priority: z.number().int(),
  parentPolicyId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const templateVersionItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  version: z.number().int(),
  status: z.string(),
  kind: z.string(),
  description: z.string().nullable(),
  parentTemplateId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const workflowVersionItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  version: z.number().int(),
  status: z.string(),
  objectType: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const versionsResponseSchema = z.discriminatedUnion("entity", [
  z.object({ entity: z.literal("policy"), name: z.string(), items: z.array(policyVersionItemSchema) }),
  z.object({ entity: z.literal("template"), name: z.string(), items: z.array(templateVersionItemSchema) }),
  z.object({ entity: z.literal("workflow"), name: z.string(), items: z.array(workflowVersionItemSchema) }),
]);

@RequireModule("hr")
@Controller("hr/settings-hub")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrSettingsHubController {
  constructor(private readonly service: HrSettingsHubService) {}

  @Get("effective-rules")
  @ResponseSchema(effectiveRulesResponseSchema)
  @RequirePermission("hr:policies:view")
  @Validate({ query: effectiveRulesQuerySchema })
  getEffectiveRules(
    @Query() query: EffectiveRulesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getEffectiveRules(u.orgId, query.employeeId, query.date);
  }

  @Get("versions")
  @ResponseSchema(versionsResponseSchema)
  @RequirePermission("hr:policies:view")
  @Validate({ query: versionsQuerySchema })
  getVersions(
    @Query() query: VersionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getVersions(u.orgId, query.entity, query.id);
  }
}
