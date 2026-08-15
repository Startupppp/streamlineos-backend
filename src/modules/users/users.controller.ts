import {
  Controller, Get, HttpCode, Patch, Delete, Post, Param, Query, Body, UseGuards, Res
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { UsersService } from "./users.service";
import { UserProfileService } from "./user-profile.service";
import { UserOpsService } from "./user-ops.service";
import { InvitationsService } from "../organization/core/invitations.service";
import { InvitationsReadService } from "../organization/core/invitations-read.service";
import { InvitationLifecycleService } from "../organization/core/invitation-lifecycle.service";
import {
  listUsersSchema, updateUserSchema, updateUserStatusSchema,
  inviteUserSchema, bulkInviteSchema, updatePreferencesSchema,
  updateMembershipSchema, bulkActionSchema, listLoginHistorySchema,
  bulkUpdateUsersSchema, listAuditSchema, importUsersRowSchema, createUserSchema,
  type ListUsersInput, type UpdateUserInput, type UpdateUserStatusInput,
  type InviteUserInput, type BulkInviteInput, type UpdatePreferencesInput,
  type UpdateMembershipInput, type BulkActionInput, type ListLoginHistoryInput,
  type BulkUpdateUsersInput, type ListAuditInput, type ImportUsersRow, type CreateUserInput,
  changeInviteRoleSchema,
  type ChangeInviteRoleInput,
  listInvitationsSchema,
  type ListInvitationsInput,
} from "./dto/users.schemas";
import { z } from "zod";

@Controller("users")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly userProfile: UserProfileService,
    private readonly userOps: UserOpsService,
    private readonly invitations: InvitationsService,
    private readonly invitationsRead: InvitationsReadService,
    private readonly invitationsLifecycle: InvitationLifecycleService,
  ) {}

  // ── Static GET routes (must be before any :userId parameterized routes) ──

  @RequirePermission("settings:view")
  @Get()
  listUsers(
    @Query(new ZodValidationPipe(listUsersSchema)) query: ListUsersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.listUsers(u.orgId, query);
  }

  @RequirePermission("settings:view")
  @Get("stats")
  getStats(@CurrentUser() u: CurrentUserContext) {
    return this.userOps.getStats(u.orgId);
  }

  @RequirePermission("settings:organization:manage")
  @Get("export")
  async exportUsers(@CurrentUser() u: CurrentUserContext, @Res() res: Response) {
    const data = await this.userOps.exportUsers(u.orgId);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=users.csv");
    res.send(data);
  }

  @RequirePermission("settings:organization:manage")
  @Get("invitations")
  listInvitations(
    @Query(new ZodValidationPipe(listInvitationsSchema)) query: ListInvitationsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invitationsRead.listPaginated(u.orgId, {
      page: query.page,
      limit: query.limit,
      includeAccepted: query.includeAccepted,
      status: query.status,
      q: query.q,
    });
  }

  @RequirePermission("settings:organization:manage")
  @Get("audit")
  getOrgAuditLog(
    @Query(new ZodValidationPipe(listAuditSchema)) query: ListAuditInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userProfile.getAuditLog(u.orgId, query);
  }

  // ── Static POST routes ──

  @RequirePermission("settings:organization:manage")
  @Post()
  createUser(
    @Body(new ZodValidationPipe(createUserSchema)) body: CreateUserInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.createUser(u.orgId, body, { userId: u.userId, isOrgOwner: u.isOrgOwner });
  }

  @RequirePermission("settings:organization:manage")
  @Post("invite")
  inviteUser(
    @Body(new ZodValidationPipe(inviteUserSchema)) body: InviteUserInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invitations.invite(
      u.orgId,
      { userId: u.userId, isOrgOwner: u.isOrgOwner, },
      body.email,
      body.role,
    );
  }

  @RequirePermission("settings:organization:manage")
  @Post("bulk-invite")
  bulkInvite(
    @Body(new ZodValidationPipe(bulkInviteSchema)) body: BulkInviteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invitations.bulkInvite(u.orgId, { userId: u.userId, isOrgOwner: u.isOrgOwner }, body.emails, body.role);
  }

  @RequirePermission("settings:organization:manage")
  @Post("bulk-suspend")
  @HttpCode(200)
  bulkSuspend(
    @Body(new ZodValidationPipe(bulkActionSchema)) body: BulkActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userOps.bulkSuspend(u.orgId, body.userIds, u.userId);
  }

  @RequirePermission("settings:organization:manage")
  @Post("bulk-archive")
  @HttpCode(200)
  bulkArchive(
    @Body(new ZodValidationPipe(bulkActionSchema)) body: BulkActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userOps.bulkArchive(u.orgId, body.userIds, u.userId);
  }

  @RequirePermission("settings:organization:manage")
  @Post("bulk-restore")
  @HttpCode(200)
  bulkRestore(
    @Body(new ZodValidationPipe(bulkActionSchema)) body: BulkActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userOps.bulkRestore(u.orgId, body.userIds, u.userId);
  }

  @RequirePermission("settings:organization:manage")
  @Post("bulk-update")
  @HttpCode(200)
  bulkUpdate(
    @Body(new ZodValidationPipe(bulkUpdateUsersSchema)) body: BulkUpdateUsersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userOps.bulkUpdateUsers(u.orgId, body, { userId: u.userId, isOrgOwner: u.isOrgOwner });
  }

  @RequirePermission("settings:organization:manage")
  @Post("import")
  importUsers(
    @Body(new ZodValidationPipe(z.object({ rows: z.array(importUsersRowSchema).min(1).max(500) })))
    body: { rows: ImportUsersRow[] },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userOps.importUsers(u.orgId, body.rows, { userId: u.userId, isOrgOwner: u.isOrgOwner });
  }

  // ── Invitation sub-routes (static prefix "invitations/") ──

  @RequirePermission("settings:organization:manage")
  @Post("invitations/:invitationId/resend")
  @HttpCode(200)
  resendInvite(@Param("invitationId") invitationId: string, @CurrentUser() u: CurrentUserContext) {
    return this.invitations.resend(u.orgId, invitationId, u.userId);
  }

  @RequirePermission("settings:organization:manage")
  @Patch("invitations/:invitationId/role")
  @HttpCode(200)
  changeInviteRole(
    @Param("invitationId") invitationId: string,
    @Body(new ZodValidationPipe(changeInviteRoleSchema)) body: ChangeInviteRoleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invitationsLifecycle.changeRole(
      u.orgId,
      invitationId,
      { userId: u.userId, isOrgOwner: u.isOrgOwner },
      body.role,
    );
  }

  @RequirePermission("settings:organization:manage")
  @Delete("invitations/:invitationId")
  cancelInvite(@Param("invitationId") invitationId: string, @CurrentUser() u: CurrentUserContext) {
    return this.invitationsLifecycle.cancel(u.orgId, invitationId, u.userId);
  }

  // ── Parameterized :userId routes (must come after all static routes) ──

  @RequirePermission("settings:view")
  @Get(":userId")
  getUser(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.users.getUser(u.orgId, userId);
  }

  @RequirePermission("settings:organization:manage")
  @Patch(":userId")
  updateUser(
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(updateUserSchema)) body: UpdateUserInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.updateUser(u.orgId, userId, body, { userId: u.userId, isOrgOwner: u.isOrgOwner });
  }

  @RequirePermission("settings:organization:manage")
  @Patch(":userId/status")
  updateStatus(
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(updateUserStatusSchema)) body: UpdateUserStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.updateUserStatus(u.orgId, userId, body.status, u.userId, body.reason);
  }

  @RequirePermission("settings:organization:manage")
  @Delete(":userId")
  deleteUser(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.users.deleteUser(u.orgId, userId, u.userId);
  }

  @RequirePermission("settings:organization:manage")
  @Get(":userId/sessions")
  getSessions(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userProfile.getUserSessions(u.orgId, userId);
  }

  @RequirePermission("settings:organization:manage")
  @Delete(":userId/sessions/:sessionId")
  revokeSession(
    @Param("userId") userId: string,
    @Param("sessionId") sessionId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userProfile.revokeSession(u.orgId, userId, sessionId, u.userId);
  }

  @RequirePermission("settings:organization:manage")
  @Delete(":userId/sessions")
  revokeAllSessions(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userProfile.revokeAllSessions(u.orgId, userId, u.userId);
  }

  @RequirePermission("settings:organization:manage")
  @Get(":userId/data-export")
  exportUserData(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userProfile.exportUserData(u.orgId, userId);
  }

  @RequirePermission("settings:organization:manage")
  @Get(":userId/activity")
  getActivity(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userProfile.getUserActivity(u.orgId, userId);
  }

  @RequirePermission("settings:view")
  @Get(":userId/preferences")
  getPreferences(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userProfile.getPreferences(u.orgId, userId);
  }

  @RequirePermission("settings:organization:manage")
  @Patch(":userId/preferences")
  updatePreferences(
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(updatePreferencesSchema)) body: UpdatePreferencesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userProfile.updatePreferences(u.orgId, userId, body);
  }

  @RequirePermission("settings:organization:manage")
  @Get(":userId/login-history")
  getLoginHistory(
    @Param("userId") userId: string,
    @Query(new ZodValidationPipe(listLoginHistorySchema)) query: ListLoginHistoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userProfile.getLoginHistory(u.orgId, userId, query);
  }

  @RequirePermission("settings:view")
  @Get(":userId/membership")
  getMembership(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userProfile.getMembership(u.orgId, userId);
  }

  @RequirePermission("settings:organization:manage")
  @Patch(":userId/membership")
  updateMembership(
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(updateMembershipSchema)) body: UpdateMembershipInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userProfile.updateMembership(u.orgId, userId, body, u.userId);
  }

  @RequirePermission("settings:organization:manage")
  @Post(":userId/send-signin-link")
  @HttpCode(200)
  sendSigninLink(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userOps.sendSigninLink(u.orgId, userId, u.userId);
  }

  @RequirePermission("settings:organization:manage")
  @Get(":userId/audit")
  getUserAuditLog(
    @Param("userId") userId: string,
    @Query(new ZodValidationPipe(listAuditSchema)) query: ListAuditInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userProfile.getUserAuditLog(u.orgId, userId, query);
  }
}
