import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { OrganizationService } from "./organization.service";
import { OrganizationSettingsService } from "./organization-settings.service";
import { InvitationsService } from "./invitations.service";
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
  restoreOrgSchema,
  schedulePurgeSchema,
  securitySettingsSchema,
  switchOrgSchema,
  updateMemberRoleSchema,
  updateOrgSettingsSchema,
  type AcceptInvitationInput,
  type AddCustomDomainInput,
  type DeclineInvitationInput,
  type CreateHolidayInput,
  type CreateOrganizationInput,
  type DeleteOrgInput,
  type ListMembersInput,
  type RestoreOrgInput,
  type SchedulePurgeInput,
  type SecuritySettingsInput,
  type SwitchOrgInput,
  type UpdateMemberRoleInput,
  type UpdateOrgSettingsInput,
} from "./dto/organization.schemas";

@Controller("organization")
@UseGuards(JwtAuthGuard)
export class OrganizationController {
  constructor(
    private readonly organization: OrganizationService,
    private readonly settings: OrganizationSettingsService,
    private readonly invitations: InvitationsService,
    private readonly invitationsRead: InvitationsReadService,
    private readonly invitationAcceptance: InvitationAcceptanceService,
    private readonly rateLimit: RateLimitService,
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
  async validateInvitationToken(
    @Query("token") token: string,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    if (!token) throw new BadRequestException("Missing token");
    await this.enforceRateLimit("invite:validate", this.getIp(req));
    return this.invitationsRead.validate(token);
  }

  @Get()
  @Universal()
  @AllowNoOrg()
  @NoTenantTransaction()
  listOrganizations(@CurrentUser() u: CurrentUserContext) {
    return this.organization.listUserOrganizations(u.userId);
  }

  @Get("archived")
  @Universal()
  @AllowNoOrg()
  @NoTenantTransaction()
  listArchivedOrganizations(@CurrentUser() u: CurrentUserContext) {
    return this.organization.listArchivedOwnedOrganizations(u.userId);
  }

  @Post()
  @HttpCode(201)
  @AuthorizedInService("createOrganization rejects a caller who is not an org owner, below")
  @Idempotent("organization.create")
  createOrganization(
    @Body(new ZodValidationPipe(createOrganizationSchema)) body: CreateOrganizationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner) {
      throw new ForbiddenException("Forbidden");
    }
    return this.organization.createOrganization(u.userId, body);
  }

  @Post("switch")
  @Universal()
  @HttpCode(200)
  @AllowNoOrg()
  @NoTenantTransaction()
  switchOrg(
    @Body(new ZodValidationPipe(switchOrgSchema)) body: SwitchOrgInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.organization.switchOrg(u.userId, body.orgId);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission("settings:view")
  @Get("members")
  listMembers(
    @Query(new ZodValidationPipe(listMembersSchema)) query: ListMembersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.organization.listMembers(u.orgId, query);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission("settings:organization:manage")
  @Patch("members/:memberId")
  updateMemberRole(
    @Param("memberId") memberId: string,
    @Body(new ZodValidationPipe(updateMemberRoleSchema)) body: UpdateMemberRoleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.organization.updateMemberRole(
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
  async removeMember(@Param("memberId") memberId: string, @CurrentUser() u: CurrentUserContext): Promise<void> {
    if (memberId === u.userId) {
      throw new BadRequestException("You cannot remove yourself from the organization");
    }
    await this.organization.removeMember(u.orgId, u.userId, memberId);
  }

  @Patch("members/:memberId/suspend")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:organization:manage")
  suspendMember(@Param("memberId") memberId: string, @CurrentUser() u: CurrentUserContext) {
    if (memberId === u.userId) {
      throw new BadRequestException("You cannot suspend yourself");
    }
    return this.organization.suspendMember(u.orgId, u.userId, memberId);
  }

  @Patch("members/:memberId/reactivate")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:organization:manage")
  reactivateMember(@Param("memberId") memberId: string, @CurrentUser() u: CurrentUserContext) {
    return this.organization.reactivateMember(u.orgId, u.userId, memberId);
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
  updateSettings(
    @Body(new ZodValidationPipe(updateOrgSettingsSchema)) body: UpdateOrgSettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.updateSettings(u.orgId, u.userId, body);
  }

  @Patch("security")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  updateSecuritySettings(
    @Body(new ZodValidationPipe(securitySettingsSchema)) body: SecuritySettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.updateSecuritySettings(u.orgId, u.userId, body);
  }

  @Public()
  @Post("invitations/accept")
  @HttpCode(200)
  async acceptInvitation(
    @Body(new ZodValidationPipe(acceptInvitationSchema)) body: AcceptInvitationInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("invite:accept", this.getIp(req));
    return this.invitationAcceptance.accept(body);
  }

  @Public()
  @Post("invitations/decline")
  @HttpCode(200)
  async declineInvitation(
    @Body(new ZodValidationPipe(declineInvitationSchema)) body: DeclineInvitationInput,
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
  addCustomDomain(
    @Body(new ZodValidationPipe(addCustomDomainSchema)) body: AddCustomDomainInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.addCustomDomain(u.orgId, u.userId, body);
  }

  @Post("custom-domains/:domainId/verify")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
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
  createHoliday(
    @Body(new ZodValidationPipe(createHolidaySchema)) body: CreateHolidayInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.createHoliday(u.orgId, u.userId, body);
  }

  @Delete("holidays/:holidayId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  async deleteHoliday(@Param("holidayId") holidayId: string, @CurrentUser() u: CurrentUserContext): Promise<void> {
    await this.settings.deleteHoliday(u.orgId, u.userId, holidayId);
  }

  @Post("archive")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  archiveOrg(@CurrentUser() u: CurrentUserContext) {
    if (!u.isOrgOwner) throw new ForbiddenException("Forbidden");
    return this.organization.archiveOrg(u.orgId, u.userId);
  }

  @Post("restore")
  @HttpCode(200)
  @AuthorizedInService("OrgLifecycleService.restoreOrg — an ACTIVE isOwner membership of the target org, 404 on a miss")
  @AllowNoOrg()
  @NoTenantTransaction()
  restoreOrg(
    @Body(new ZodValidationPipe(restoreOrgSchema)) body: RestoreOrgInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.organization.restoreOrg(body.orgId, u.userId);
  }

  @Post("leave")
  @Universal()
  @HttpCode(200)
  leaveOrg(@CurrentUser() u: CurrentUserContext) {
    return this.organization.leaveOrg(u.orgId, u.userId);
  }

  @Delete()
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  deleteOrg(
    @Body(new ZodValidationPipe(deleteOrgSchema)) body: DeleteOrgInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner) throw new ForbiddenException("Forbidden");
    return this.organization.deleteOrg(u.orgId, u.userId, body.confirmation);
  }

  @Post(":orgId/purge/schedule")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  schedulePurge(
    @Param("orgId") orgId: string,
    @Body(new ZodValidationPipe(schedulePurgeSchema)) body: SchedulePurgeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner) throw new ForbiddenException("Forbidden");
    const targetOrgId = u.orgId;
    return this.organization.schedulePurge(
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
  cancelPurge(
    @Param("orgId") orgId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner) throw new ForbiddenException("Forbidden");
    const targetOrgId = u.orgId;
    return this.organization.cancelPurge(targetOrgId, u.userId);
  }
}
