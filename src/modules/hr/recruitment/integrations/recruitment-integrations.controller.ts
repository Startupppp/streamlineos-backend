import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { Validate } from "../../../../common/validation/validate.decorator";
import {
  BodylessAction,
  ResponseSchema,
} from "../../../../common/openapi/zod-operation-contracts";
import { Idempotent } from "../../../../common/idempotency/idempotent.decorator";
import { RecruitmentIntegrationsService } from "./recruitment-integrations.service";
import { INTEGRATION_FAMILIES } from "./integration-catalog";
import { ZodValidationPipe } from "../../../../common/pipes/zod-validation.pipe";

export const integrationStatusSchema = z.object({
  platform: z.string(),
  family: z.enum(INTEGRATION_FAMILIES),
  label: z.string(),
  does: z.string(),
  manualFallback: z.string().nullable(),
  adapterImplemented: z.boolean(),
  blockedBy: z.string().nullable(),
  connected: z.boolean(),
  isActive: z.boolean(),
  hasCredentials: z.boolean(),
  /** Last four characters only — enough to tell two keys apart, never enough to use one. */
  credentialHint: z.string().nullable(),
  blockedCode: z.enum(["no-integration", "inactive", "needs-keys", "not-implemented"]).nullable(),
});

export const connectIntegrationSchema = z
  .object({
    token: z.string().trim().max(4000).nullable().optional(),
    isActive: z.boolean().optional(),
    meta: z.record(z.string().max(100), z.unknown()).optional(),
  })
  .strict();

export const rotateSecretResponseSchema = z.object({
  platform: z.string(),
  /** Returned exactly once. The list endpoint never shows it again. */
  inboundSecret: z.string(),
  callbackPath: z.string(),
});

export type ConnectIntegrationInput = z.infer<typeof connectIntegrationSchema>;

/**
 * The integrations desk.
 *
 * `hr:requisitions:manage` rather than a view key on every route, including the
 * list: knowing which boards an organisation has connected and which keys are
 * held is administrative, and the list is the screen from which they are
 * changed.
 */
@RequireModule("hr")
@Controller("hr/recruitment/integrations")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentIntegrationsController {
  constructor(private readonly integrations: RecruitmentIntegrationsService) {}

  @Get()
  @RequirePermission("hr:requisitions:manage")
  @ResponseSchema(z.array(integrationStatusSchema))
  list(@CurrentUser() u: CurrentUserContext) {
    return this.integrations.list(u.orgId);
  }

  @Put(":platform")
  @RequirePermission("hr:requisitions:manage")
  @Validate({ body: connectIntegrationSchema })
  @ResponseSchema(integrationStatusSchema)
  connect(
    @Param("platform", new ZodValidationPipe(z.string().min(1).max(64))) platform: string,
    @Body() body: ConnectIntegrationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.integrations.connect(u.orgId, u.userId, platform.toUpperCase(), body);
  }

  @Delete(":platform")
  @RequirePermission("hr:requisitions:manage")
  @ResponseSchema(z.object({ platform: z.string() }))
  disconnect(
    @Param("platform", new ZodValidationPipe(z.string().min(1).max(64))) platform: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.integrations.disconnect(u.orgId, u.userId, platform.toUpperCase());
  }

  @Post(":platform/inbound-secret")
  @RequirePermission("hr:requisitions:manage")
  @Idempotent("hr.recruitment.rotate-inbound-secret")
  @BodylessAction()
  @ResponseSchema(rotateSecretResponseSchema)
  rotateInboundSecret(
    @Param("platform", new ZodValidationPipe(z.string().min(1).max(64))) platform: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.integrations.rotateInboundSecret(u.orgId, u.userId, platform.toUpperCase());
  }
}
