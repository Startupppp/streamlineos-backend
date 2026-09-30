import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import { RateLimitService } from "../../../common/ratelimit/rate-limit.service";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { Universal } from "../../../common/auth/universal.decorator";
import { AuthorizedInService } from "../../../common/auth/authorized-in-service.decorator";
import { Public } from "../../../common/auth/public.decorator";
import { AllowNoOrg } from "../../../common/auth/allow-no-org.decorator";
import { NoTenantTransaction } from "../../../common/tenant";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { OrgProfileService } from "./org-profile.service";
import { OrgLifecycleService } from "./org-lifecycle.service";
import { OrganizationSettingsService } from "./organization-settings.service";
import { InvitationsReadService } from "./invitations-read.service";
import { InvitationAcceptanceService } from "./invitation-acceptance.service";
import {
  acceptInvitationSchema,
  declineInvitationSchema,
  createOrganizationSchema,
  requestInvitationOtpSchema,
  securitySettingsSchema,
  switchOrgSchema,
  updateOrgSettingsSchema,
  validateInvitationTokenQuerySchema,
  type AcceptInvitationInput,
  type DeclineInvitationInput,
  type CreateOrganizationInput,
  type RequestInvitationOtpInput,
  type SecuritySettingsInput,
  type SwitchOrgInput,
  type UpdateOrgSettingsInput,
  type ValidateInvitationTokenQuery,
} from "./dto/organization.schemas";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  invitationValidateResponseSchema,
  orgListResponseSchema,
  archivedOrgListResponseSchema,
  createOrgResponseSchema,
  switchOrgResponseSchema,
  orgSettingsResponseSchema,
  updateOrgSettingsResponseSchema,
  requestInvitationOtpResponseSchema,
  acceptInvitationResponseSchema,
  declineInvitationResponseSchema,
} from "./dto/organization-core-response.schemas";
import { resolveClientIpOr } from "../../../common/http/client-ip";

@Controller("organization")
@UseGuards(JwtAuthGuard)
export class OrganizationController {
  constructor(
    private readonly orgProfile: OrgProfileService,
    private readonly orgLifecycle: OrgLifecycleService,
    private readonly settings: OrganizationSettingsService,
    private readonly invitationsRead: InvitationsReadService,
    private readonly invitationAcceptance: InvitationAcceptanceService,
    private readonly rateLimit: RateLimitService,
  ) {}

  private getIp(req: { ip?: string; headers: Record<string, string> }): string {
    return resolveClientIpOr(req, "unknown");
  }

  private async enforceRateLimit(tier: string, identifier: string): Promise<void> {
    const result = await this.rateLimit.check(tier, identifier);
    if (!result.allowed) {
      throw new HttpException(
        {
          code: "AUTH_RATE_LIMITED",
          message: "Too many attempts. Try again later.",
          details: { retryAfterSeconds: result.retryAfterSecs },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  @Public()
  @Get("invitations/validate")
  @ResponseSchema(invitationValidateResponseSchema)
  @Validate({ query: validateInvitationTokenQuerySchema })
  async validateInvitationToken(
    @Query() query: ValidateInvitationTokenQuery,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("invite:validate", this.getIp(req));
    return this.invitationsRead.validate(query.token);
  }

  @Get()
  @ResponseSchema(orgListResponseSchema)
  @Universal()
  @AllowNoOrg()
  @NoTenantTransaction()
  listOrganizations(@CurrentUser() u: CurrentUserContext) {
    return this.orgProfile.listUserOrganizations(u.userId);
  }

  @Get("archived")
  @ResponseSchema(archivedOrgListResponseSchema)
  @Universal()
  @AllowNoOrg()
  @NoTenantTransaction()
  listArchivedOrganizations(@CurrentUser() u: CurrentUserContext) {
    return this.orgLifecycle.listArchivedOwnedOrganizations(u.userId);
  }

  @Post()
  @ResponseSchema(createOrgResponseSchema)
  @HttpCode(201)
  @UseGuards(RateLimitGuard)
  @AuthorizedInService("any authenticated user may create a new organisation; an organisation is a tenant, not a metered resource, so there is deliberately NO count cap — @UseRateLimit(\"organization:create\") is the abuse control")
  @UseRateLimit("organization:create")
  @Idempotent("organization.create")
  @NoTenantTransaction()
  @Validate({ body: createOrganizationSchema })
  createOrganization(
    @Body() body: CreateOrganizationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgProfile.createOrganization(u.userId, body);
  }

  @Post("switch")
  @ResponseSchema(switchOrgResponseSchema)
  @Universal()
  @HttpCode(200)
  @AllowNoOrg()
  @NoTenantTransaction()
  @Validate({ body: switchOrgSchema })
  switchOrg(
    @Body() body: SwitchOrgInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgProfile.switchOrg(u.userId, body.orgId);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission("settings:view")
  @Get("settings")
  @ResponseSchema(orgSettingsResponseSchema)
  async getSettings(@CurrentUser() u: CurrentUserContext) {
    const result = await this.settings.getSettings(u.orgId);
    if (!result) throw new NotFoundException("Organization not found");
    return result;
  }

  @Patch("settings")
  @ResponseSchema(updateOrgSettingsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  @Validate({ body: updateOrgSettingsSchema })
  updateSettings(
    @Body() body: UpdateOrgSettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.updateSettings(u.orgId, u.userId, body);
  }

  @Patch("security")
  @ResponseSchema(updateOrgSettingsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  @Validate({ body: securitySettingsSchema })
  updateSecuritySettings(
    @Body() body: SecuritySettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.updateSecuritySettings(u.orgId, u.userId, body);
  }

  @Public()
  @Post("invitations/request-otp")
  @ResponseSchema(requestInvitationOtpResponseSchema)
  @HttpCode(200)
  @Validate({ body: requestInvitationOtpSchema })
  async requestInvitationOtp(
    @Body() body: RequestInvitationOtpInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("invite:request-otp", this.getIp(req));
    return this.invitationAcceptance.requestInvitationEmailOtp(body.token);
  }

  @Public()
  @Post("invitations/accept")
  @ResponseSchema(acceptInvitationResponseSchema)
  @HttpCode(200)
  @Validate({ body: acceptInvitationSchema })
  async acceptInvitation(
    @Body() body: AcceptInvitationInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("invite:accept", this.getIp(req));
    return this.invitationAcceptance.accept(body);
  }

  @Public()
  @Post("invitations/decline")
  @ResponseSchema(declineInvitationResponseSchema)
  @HttpCode(200)
  @Validate({ body: declineInvitationSchema })
  async declineInvitation(
    @Body() body: DeclineInvitationInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("invite:accept", this.getIp(req));
    return this.invitationAcceptance.decline(body);
  }
}
