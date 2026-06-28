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
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { defineAbilityFor } from "../../common/rbac/abilities.factory";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { OrganizationService } from "./organization.service";
import {
  addCustomDomainSchema,
  cancelInvitationSchema,
  createOrganizationSchema,
  createHolidaySchema,
  inviteMemberSchema,
  transferOwnershipSchema,
  listMembersSchema,
  securitySettingsSchema,
  switchOrgSchema,
  updateMemberRoleSchema,
  updateOrgSettingsSchema,
  type AddCustomDomainInput,
  type CancelInvitationInput,
  type CreateHolidayInput,
  type CreateOrganizationInput,
  type TransferOwnershipInput,
  type InviteMemberInput,
  type ListMembersInput,
  type SecuritySettingsInput,
  type SwitchOrgInput,
  type UpdateMemberRoleInput,
  type UpdateOrgSettingsInput,
} from "./dto/organization.schemas";

@Controller("organization")
@UseGuards(JwtAuthGuard, AbilityGuard)
export class OrganizationController {
  constructor(private readonly organization: OrganizationService) {}

  @Get()
  listOrganizations(@CurrentUser() u: CurrentUserContext) {
    return this.organization.listUserOrganizations(u.userId);
  }

  @Post()
  @HttpCode(201)
  @CheckAbility("manage", "all")
  createOrganization(
    @Body(new ZodValidationPipe(createOrganizationSchema)) body: CreateOrganizationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
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

  @Get("profile")
  async getProfile(@CurrentUser() u: CurrentUserContext) {
    const profile = await this.organization.getProfile(u.userId, u.orgId);
    if (!profile) throw new NotFoundException("User not found");
    return profile;
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
  @CheckAbility("manage", "settings")
  inviteMember(
    @Body(new ZodValidationPipe(inviteMemberSchema)) body: InviteMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.organization.inviteMember(u.orgId, u.userId, body);
  }

  @Patch("members/:memberId")
  @CheckAbility("manage", "all")
  updateMemberRole(
    @Param("memberId") memberId: string,
    @Body(new ZodValidationPipe(updateMemberRoleSchema)) body: UpdateMemberRoleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.organization.updateMemberRole(u.orgId, u.userId, memberId, body.role);
  }

  @Delete("members/:memberId")
  removeMember(@Param("memberId") memberId: string, @CurrentUser() u: CurrentUserContext) {
    if (memberId === u.userId) {
      throw new BadRequestException("You cannot remove yourself from the organization");
    }
    const ability = defineAbilityFor(u);
    if (!ability.can("manage", "settings")) {
      throw new ForbiddenException("Forbidden");
    }
    return this.organization.removeMember(u.orgId, u.userId, memberId);
  }

  @Get("invitations")
  @CheckAbility("manage", "settings")
  listInvitations(@CurrentUser() u: CurrentUserContext) {
    return this.organization.listInvitations(u.orgId);
  }

  @Delete("invitations")
  @CheckAbility("manage", "settings")
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
  updateSettings(
    @Body(new ZodValidationPipe(updateOrgSettingsSchema)) body: UpdateOrgSettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const ability = defineAbilityFor(u);
    if (!ability.can("manage", "settings")) {
      throw new ForbiddenException("Forbidden");
    }
    return this.organization.updateSettings(u.orgId, u.userId, body);
  }

  @Patch("security")
  @CheckAbility("manage", "settings")
  updateSecuritySettings(
    @Body(new ZodValidationPipe(securitySettingsSchema)) body: SecuritySettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.organization.updateSecuritySettings(u.orgId, u.userId, body);
  }

  @Post("archive")
  @CheckAbility("manage", "settings")
  archiveOrg(@CurrentUser() u: CurrentUserContext) {
    if (!u.isOrgOwner) throw new ForbiddenException("Only the org owner can archive");
    return this.organization.archiveOrg(u.orgId, u.userId);
  }

  @Post("restore")
  @CheckAbility("manage", "settings")
  restoreOrg(@CurrentUser() u: CurrentUserContext) {
    if (!u.isOrgOwner) throw new ForbiddenException("Only the org owner can restore");
    return this.organization.restoreOrg(u.orgId, u.userId);
  }

  @Post("transfer-ownership")
  @CheckAbility("manage", "settings")
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
  @CheckAbility("manage", "settings")
  addCustomDomain(
    @Body(new ZodValidationPipe(addCustomDomainSchema)) body: AddCustomDomainInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.organization.addCustomDomain(u.orgId, u.userId, body);
  }

  @Post("custom-domains/:domainId/verify")
  @CheckAbility("manage", "settings")
  verifyCustomDomain(@Param("domainId") domainId: string, @CurrentUser() u: CurrentUserContext) {
    return this.organization.verifyCustomDomain(u.orgId, u.userId, domainId);
  }

  @Delete("custom-domains/:domainId")
  @CheckAbility("manage", "settings")
  removeCustomDomain(@Param("domainId") domainId: string, @CurrentUser() u: CurrentUserContext) {
    return this.organization.removeCustomDomain(u.orgId, u.userId, domainId);
  }

  @Get("holidays")
  listHolidays(@CurrentUser() u: CurrentUserContext) {
    return this.organization.listHolidays(u.orgId);
  }

  @Post("holidays")
  @CheckAbility("manage", "settings")
  createHoliday(
    @Body(new ZodValidationPipe(createHolidaySchema)) body: CreateHolidayInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.organization.createHoliday(u.orgId, u.userId, body);
  }

  @Delete("holidays/:holidayId")
  @CheckAbility("manage", "settings")
  deleteHoliday(@Param("holidayId") holidayId: string, @CurrentUser() u: CurrentUserContext) {
    return this.organization.deleteHoliday(u.orgId, u.userId, holidayId);
  }
}
