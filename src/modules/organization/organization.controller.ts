import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Public } from "../../common/auth/public.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { OrganizationService } from "./organization.service";
import {
  acceptInvitationSchema,
  addCustomDomainSchema,
  cancelInvitationSchema,
  createOrganizationSchema,
  createHolidaySchema,
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
  type InviteMemberInput,
  type ListMembersInput,
  type SecuritySettingsInput,
  type SwitchOrgInput,
  type TransferOwnershipInput,
  type UpdateMemberRoleInput,
  type UpdateOrgSettingsInput,
} from "./dto/organization.schemas";

@Controller("organization")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class OrganizationController {
  constructor(private readonly organization: OrganizationService) {}

  @Public()
  @Get("invitations/validate")
  validateInvitationToken(@Query("token") token: string) {
    if (!token) throw new BadRequestException("Missing token");
    return this.organization.validateInvitationToken(token);
  }

  @Public()
  @Get("setup-token/validate")
  validateSetupToken(@Query("token") token: string) {
    if (!token) throw new BadRequestException("Missing token");
    return this.organization.validateSetupToken(token);
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

  @Get("members")
  listMembers(
    @Query(new ZodValidationPipe(listMembersSchema)) query: ListMembersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.organization.listMembers(u.orgId, query);
  }

  @Post("members")
  @HttpCode(201)
  @RequirePermission("settings:manage")
  inviteMember(
    @Body(new ZodValidationPipe(inviteMemberSchema)) body: InviteMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.organization.inviteMember(u.orgId, u.userId, body);
  }

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
  @RequirePermission("settings:manage")
  removeMember(@Param("memberId") memberId: string, @CurrentUser() u: CurrentUserContext) {
    if (memberId === u.userId) {
      throw new BadRequestException("You cannot remove yourself from the organization");
    }
    return this.organization.removeMember(u.orgId, u.userId, memberId);
  }

  @Get("invitations")
  @RequirePermission("settings:manage")
  listInvitations(@CurrentUser() u: CurrentUserContext) {
    return this.organization.listInvitations(u.orgId);
  }

  @Delete("invitations")
  @RequirePermission("settings:manage")
  cancelInvitation(
    @Body(new ZodValidationPipe(cancelInvitationSchema)) body: CancelInvitationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.organization.cancelInvitation(u.orgId, body.invitationId);
  }

  @Get("settings")
  async getSettings(@CurrentUser() u: CurrentUserContext) {
    const settings = await this.organization.getSettings(u.orgId);
    if (!settings) throw new NotFoundException("Organization not found");
    return settings;
  }

  @Patch("settings")
  @RequirePermission("settings:manage")
  updateSettings(
    @Body(new ZodValidationPipe(updateOrgSettingsSchema)) body: UpdateOrgSettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.organization.updateSettings(u.orgId, u.userId, body);
  }

  @Patch("security")
  @RequirePermission("settings:manage")
  updateSecuritySettings(
    @Body(new ZodValidationPipe(securitySettingsSchema)) body: SecuritySettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.organization.updateSecuritySettings(u.orgId, u.userId, body);
  }

  @Public()
  @Post("invitations/accept")
  @HttpCode(200)
  acceptInvitation(
    @Body(new ZodValidationPipe(acceptInvitationSchema)) body: AcceptInvitationInput,
  ) {
    return this.organization.acceptInvitation(body);
  }

  @Post("archive")
  @RequirePermission("settings:manage")
  archiveOrg(@CurrentUser() u: CurrentUserContext) {
    if (!u.isOrgOwner) throw new ForbiddenException("Only the org owner can archive");
    return this.organization.archiveOrg(u.orgId, u.userId);
  }

  @Post("restore")
  @RequirePermission("settings:manage")
  restoreOrg(@CurrentUser() u: CurrentUserContext) {
    if (!u.isOrgOwner) throw new ForbiddenException("Only the org owner can restore");
    return this.organization.restoreOrg(u.orgId, u.userId);
  }

  @Post("transfer-ownership")
  @RequirePermission("settings:manage")
  transferOwnership(
    @Body(new ZodValidationPipe(transferOwnershipSchema)) body: TransferOwnershipInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner) throw new ForbiddenException("Only the current owner can transfer ownership");
    return this.organization.transferOwnership(u.orgId, u.userId, body);
  }

  @Get("custom-domains")
  listCustomDomains(@CurrentUser() u: CurrentUserContext) {
    return this.organization.listCustomDomains(u.orgId);
  }

  @Post("custom-domains")
  @RequirePermission("settings:manage")
  addCustomDomain(
    @Body(new ZodValidationPipe(addCustomDomainSchema)) body: AddCustomDomainInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.organization.addCustomDomain(u.orgId, u.userId, body);
  }

  @Post("custom-domains/:domainId/verify")
  @RequirePermission("settings:manage")
  verifyCustomDomain(@Param("domainId") domainId: string, @CurrentUser() u: CurrentUserContext) {
    return this.organization.verifyCustomDomain(u.orgId, u.userId, domainId);
  }

  @Delete("custom-domains/:domainId")
  @RequirePermission("settings:manage")
  removeCustomDomain(@Param("domainId") domainId: string, @CurrentUser() u: CurrentUserContext) {
    return this.organization.removeCustomDomain(u.orgId, u.userId, domainId);
  }

  @Get("holidays")
  listHolidays(@CurrentUser() u: CurrentUserContext) {
    return this.organization.listHolidays(u.orgId);
  }

  @Post("holidays")
  @RequirePermission("settings:manage")
  createHoliday(
    @Body(new ZodValidationPipe(createHolidaySchema)) body: CreateHolidayInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.organization.createHoliday(u.orgId, u.userId, body);
  }

  @Delete("holidays/:holidayId")
  @RequirePermission("settings:manage")
  deleteHoliday(@Param("holidayId") holidayId: string, @CurrentUser() u: CurrentUserContext) {
    return this.organization.deleteHoliday(u.orgId, u.userId, holidayId);
  }
}
