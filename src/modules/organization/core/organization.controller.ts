import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
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
import { assertOwnerOnly } from "../../../common/rbac/owner-only-operations";
import { assertPathOrgIsCallerOrg } from "./assert-path-org";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { OrgProfileService } from "./org-profile.service";
import { OrgMembershipService } from "./org-membership.service";
import { OrgMembershipStatusService } from "./org-membership-status.service";
import { OrgMemberDepartureService } from "./org-member-departure.service";
import { OrgLifecycleService } from "./org-lifecycle.service";
import { OrgPurgeService } from "./org-purge.service";
import { OrganizationSettingsService } from "./organization-settings.service";
import { OrganizationLegalHoldService } from "./lifecycle/organization-legal-hold.service";
import { InvitationsReadService } from "./invitations-read.service";
import { InvitationAcceptanceService } from "./invitation-acceptance.service";
import {
  acceptInvitationSchema,
  addCustomDomainSchema,
  declineInvitationSchema,
  createOrganizationSchema,
  createHolidaySchema,
  deleteOrgSchema,
  listMembersSchema,
  placeLegalHoldSchema,
  restoreOrgSchema,
  schedulePurgeSchema,
  securitySettingsSchema,
  switchOrgSchema,
  updateMemberRoleSchema,
  updateOrgSettingsSchema,
  validateInvitationTokenQuerySchema,
  type AcceptInvitationInput,
  type AddCustomDomainInput,
  type DeclineInvitationInput,
  type CreateHolidayInput,
  type CreateOrganizationInput,
  type DeleteOrgInput,
  type ListMembersInput,
  type PlaceLegalHoldInput,
  type RestoreOrgInput,
  type SchedulePurgeInput,
  type SecuritySettingsInput,
  type SwitchOrgInput,
  type UpdateMemberRoleInput,
  type UpdateOrgSettingsInput,
  type ValidateInvitationTokenQuery,
} from "./dto/organization.schemas";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { z } from "zod";

const memberIdParams = z.object({ memberId: z.string().min(1) }).strict();
const domainIdParams = z.object({ domainId: z.string().min(1) }).strict();
const holidayIdParams = z.object({ holidayId: z.string().min(1) }).strict();
const orgIdParams = z.object({ orgId: z.string().min(1) }).strict();
const holdIdParams = z.object({ holdId: z.string().min(1) }).strict();

@Controller("organization")
@UseGuards(JwtAuthGuard)
export class OrganizationController {
  constructor(
    private readonly orgProfile: OrgProfileService,
    private readonly orgMembership: OrgMembershipService,
    private readonly orgMembershipStatus: OrgMembershipStatusService,
    private readonly orgMemberDeparture: OrgMemberDepartureService,
    private readonly orgLifecycle: OrgLifecycleService,
    private readonly orgPurge: OrgPurgeService,
    private readonly settings: OrganizationSettingsService,
    private readonly invitationsRead: InvitationsReadService,
    private readonly invitationAcceptance: InvitationAcceptanceService,
    private readonly rateLimit: RateLimitService,
    private readonly legalHold: OrganizationLegalHoldService,
  ) {}

  private getIp(req: { ip?: string; headers: Record<string, string> }): string {
    return req.headers["x-forwarded-for"]?.split(",")?.[0]?.trim() ?? req.ip ?? "unknown";
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
  @Validate({ query: validateInvitationTokenQuerySchema })
  async validateInvitationToken(
    @Query() query: ValidateInvitationTokenQuery,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("invite:validate", this.getIp(req));
    return this.invitationsRead.validate(query.token);
  }

  @Get()
  @Universal()
  @AllowNoOrg()
  @NoTenantTransaction()
  listOrganizations(@CurrentUser() u: CurrentUserContext) {
    return this.orgProfile.listUserOrganizations(u.userId);
  }

  @Get("archived")
  @Universal()
  @AllowNoOrg()
  @NoTenantTransaction()
  listArchivedOrganizations(@CurrentUser() u: CurrentUserContext) {
    return this.orgLifecycle.listArchivedOwnedOrganizations(u.userId);
  }

  @Post()
  @HttpCode(201)
  @UseGuards(RateLimitGuard)
  @AuthorizedInService("any authenticated user may create a new organisation; plan limits enforced in OrgProfileService.createOrganization")
  @UseRateLimit("organization:create")
  @Idempotent("organization.create")
  @Validate({ body: createOrganizationSchema })
  createOrganization(
    @Body() body: CreateOrganizationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgProfile.createOrganization(u.userId, body);
  }

  @Post("switch")
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
  @Get("members")
  @Validate({ query: listMembersSchema })
  listMembers(
    @Query() query: ListMembersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgMembership.listMembers(u.orgId, query);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission("settings:organization:manage")
  @Patch("members/:memberId")
  @Validate({ params: memberIdParams, body: updateMemberRoleSchema })
  updateMemberRole(
    @Param("memberId") memberId: string,
    @Body() body: UpdateMemberRoleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgMembership.updateMemberRole(
      u.orgId,
      { userId: u.userId, isOrgOwner: u.isOrgOwner },
      memberId,
      body.role,
    );
  }

  @Delete("members/:memberId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:organization:manage")
  @Validate({ params: memberIdParams })
  async removeMember(@Param("memberId") memberId: string, @CurrentUser() u: CurrentUserContext): Promise<void> {
    if (memberId === u.userId) {
      throw new BadRequestException("You cannot remove yourself from the organization");
    }
    await this.orgMemberDeparture.removeMember(u.orgId, u.userId, memberId);
  }

  @Patch("members/:memberId/suspend")
  @BodylessAction()
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:organization:manage")
  @Validate({ params: memberIdParams })
  suspendMember(@Param("memberId") memberId: string, @CurrentUser() u: CurrentUserContext) {
    if (memberId === u.userId) {
      throw new BadRequestException("You cannot suspend yourself");
    }
    return this.orgMembershipStatus.suspendMember(u.orgId, u.userId, memberId);
  }

  @Patch("members/:memberId/reactivate")
  @BodylessAction()
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:organization:manage")
  @Validate({ params: memberIdParams })
  reactivateMember(@Param("memberId") memberId: string, @CurrentUser() u: CurrentUserContext) {
    return this.orgMembershipStatus.reactivateMember(u.orgId, u.userId, memberId);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission("settings:view")
  @Get("settings")
  async getSettings(@CurrentUser() u: CurrentUserContext) {
    const result = await this.settings.getSettings(u.orgId);
    if (!result) throw new NotFoundException("Organization not found");
    return result;
  }

  @Patch("settings")
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
  @Post("invitations/accept")
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
  @HttpCode(200)
  @Validate({ body: declineInvitationSchema })
  async declineInvitation(
    @Body() body: DeclineInvitationInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("invite:accept", this.getIp(req));
    return this.invitationAcceptance.decline(body);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission("settings:view")
  @Get("custom-domains")
  listCustomDomains(@CurrentUser() u: CurrentUserContext) {
    return this.settings.listCustomDomains(u.orgId);
  }

  @Post("custom-domains")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  @Validate({ body: addCustomDomainSchema })
  addCustomDomain(
    @Body() body: AddCustomDomainInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.addCustomDomain(u.orgId, u.userId, body);
  }

  @Post("custom-domains/:domainId/verify")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  @Validate({ params: domainIdParams })
  verifyCustomDomain(
    @Param("domainId") domainId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.verifyCustomDomain(u.orgId, u.userId, domainId);
  }

  @Delete("custom-domains/:domainId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  @Validate({ params: domainIdParams })
  async removeCustomDomain(
    @Param("domainId") domainId: string,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<void> {
    await this.settings.removeCustomDomain(u.orgId, u.userId, domainId);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission("settings:view")
  @Get("holidays")
  listHolidays(@CurrentUser() u: CurrentUserContext) {
    return this.settings.listHolidays(u.orgId);
  }

  @Post("holidays")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  @Validate({ body: createHolidaySchema })
  createHoliday(
    @Body() body: CreateHolidayInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.createHoliday(u.orgId, u.userId, body);
  }

  @Delete("holidays/:holidayId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  @Validate({ params: holidayIdParams })
  async deleteHoliday(@Param("holidayId") holidayId: string, @CurrentUser() u: CurrentUserContext): Promise<void> {
    await this.settings.deleteHoliday(u.orgId, u.userId, holidayId);
  }

  @Post("archive")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  archiveOrg(@CurrentUser() u: CurrentUserContext) {
    assertOwnerOnly(u, "organization.archive");
    return this.orgLifecycle.archiveOrg(u.orgId, u.userId);
  }

  @Post("restore")
  @HttpCode(200)
  @AuthorizedInService("OrgLifecycleService.restoreOrg — an ACTIVE isOwner membership of the target org, 404 on a miss")
  @AllowNoOrg()
  @NoTenantTransaction()
  @Validate({ body: restoreOrgSchema })
  restoreOrg(
    @Body() body: RestoreOrgInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgLifecycle.restoreOrg(body.orgId, u.userId);
  }

  @Post("leave")
  @BodylessAction()
  @Universal()
  @HttpCode(200)
  leaveOrg(@CurrentUser() u: CurrentUserContext) {
    return this.orgMemberDeparture.leaveOrg(u.orgId, u.userId);
  }

  @Delete()
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  @Validate({ body: deleteOrgSchema })
  deleteOrg(
    @Body() body: DeleteOrgInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertOwnerOnly(u, "organization.delete");
    return this.orgPurge.deleteOrg(u.orgId, u.userId, body.confirmation);
  }

  @Post(":orgId/purge/schedule")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  @Validate({ params: orgIdParams, body: schedulePurgeSchema })
  schedulePurge(
    @Param("orgId") orgId: string,
    @Body() body: SchedulePurgeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertOwnerOnly(u, "organization.purge.schedule");
    assertPathOrgIsCallerOrg(orgId, u.orgId);
    const targetOrgId = u.orgId;
    return this.orgPurge.schedulePurge(
      targetOrgId,
      u.userId,
      body.scheduledForDays,
      body.reason,
    );
  }

  @Delete(":orgId/purge")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  @Validate({ params: orgIdParams })
  cancelPurge(
    @Param("orgId") orgId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertOwnerOnly(u, "organization.purge.cancel");
    assertPathOrgIsCallerOrg(orgId, u.orgId);
    const targetOrgId = u.orgId;
    return this.orgPurge.cancelPurge(targetOrgId, u.userId);
  }

  @Post("legal-holds")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:organization:manage")
  @Validate({ body: placeLegalHoldSchema })
  placeLegalHold(
    @Body() body: PlaceLegalHoldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertOwnerOnly(u, "organization.legal-hold");
    return this.legalHold.place(u.orgId, u.userId, body.reason);
  }

  @Get("legal-holds")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:organization:manage")
  listLegalHolds(@CurrentUser() u: CurrentUserContext) {
    return this.legalHold.listActive(u.orgId);
  }

  @Delete("legal-holds/:holdId")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:organization:manage")
  @Validate({ params: holdIdParams })
  releaseLegalHold(
    @Param("holdId") holdId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertOwnerOnly(u, "organization.legal-hold");
    return this.legalHold.release(holdId, u.orgId, u.userId);
  }
}
