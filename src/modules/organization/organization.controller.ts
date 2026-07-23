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
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Public } from "../../common/auth/public.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { OrganizationService } from "./organization.service";
import { OrganizationSettingsService } from "./organization-settings.service";
import { InvitationsService } from "./invitations.service";
import {
  acceptInvitationSchema,
  addCustomDomainSchema,
  cancelInvitationSchema,
  createOrganizationSchema,
  createHolidaySchema,
  deleteOrgSchema,
  inviteMemberSchema,
  listMembersSchema,
  securitySettingsSchema,
  switchOrgSchema,
  transferOwnershipSchema,
  updateMemberRoleSchema,
  updateOrgSettingsSchema,
  type AcceptInvitationInput,
  type AddCustomDomainInput,
  type CancelInvitationInput,
  type CreateHolidayInput,
  type CreateOrganizationInput,
  type DeleteOrgInput,
  type InviteMemberInput,
  type ListMembersInput,
  type SecuritySettingsInput,
  type SwitchOrgInput,
  type TransferOwnershipInput,
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
    return this.invitations.validate(token);
  }

  @Get()
  listOrganizations(@CurrentUser() u: CurrentUserContext) {
    return this.organization.listUserOrganizations(u.userId);
  }

  @Post()
  @HttpCode(201)
  createOrganization(
    @Body(new ZodValidationPipe(createOrganizationSchema)) body: CreateOrganizationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      throw new ForbiddenException("Forbidden");
    }
    return this.organization.createOrganization(u.userId, body);
  }

  @Post("switch")
  @HttpCode(200)
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

  @Post("members")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  inviteMember(
    @Body(new ZodValidationPipe(inviteMemberSchema)) body: InviteMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invitations.invite(u.orgId, u.userId, body.email, body.role);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  @Patch("members/:memberId")
  updateMemberRole(
    @Param("memberId") memberId: string,
    @Body(new ZodValidationPipe(updateMemberRoleSchema)) body: UpdateMemberRoleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      throw new ForbiddenException("Forbidden");
    }
    return this.organization.updateMemberRole(u.orgId, u.userId, memberId, body.role);
  }

  @Delete("members/:memberId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  async removeMember(@Param("memberId") memberId: string, @CurrentUser() u: CurrentUserContext): Promise<void> {
    if (memberId === u.userId) {
      throw new BadRequestException("You cannot remove yourself from the organization");
    }
    await this.organization.removeMember(u.orgId, u.userId, memberId);
  }

  @Get("invitations")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  listInvitations(@CurrentUser() u: CurrentUserContext) {
    return this.invitations.listPending(u.orgId);
  }

  @Delete("invitations")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  cancelInvitation(
    @Body(new ZodValidationPipe(cancelInvitationSchema)) body: CancelInvitationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invitations.cancel(u.orgId, body.invitationId, u.userId);
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
    return this.invitations.accept(body);
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
    if (!u.isOrgOwner && !u.isPlatformAdmin) throw new ForbiddenException("Forbidden");
    return this.organization.archiveOrg(u.orgId, u.userId);
  }

  @Post("restore")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  restoreOrg(@CurrentUser() u: CurrentUserContext) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) throw new ForbiddenException("Forbidden");
    return this.organization.restoreOrg(u.orgId, u.userId);
  }

  @Post("transfer-ownership")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  transferOwnership(
    @Body(new ZodValidationPipe(transferOwnershipSchema)) body: TransferOwnershipInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) throw new ForbiddenException("Forbidden");
    return this.organization.transferOwnership(u.orgId, u.userId, body);
  }

  @Post("leave")
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
    if (!u.isOrgOwner && !u.isPlatformAdmin) throw new ForbiddenException("Forbidden");
    return this.organization.deleteOrg(u.orgId, u.userId, body.confirmation);
  }
}
