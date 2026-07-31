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
} from "./dto/users.schemas";
import { z } from "zod";

const listInvitationsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  includeAccepted: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
});
type ListInvitationsInput = z.infer<typeof listInvitationsSchema>;

@Controller("users")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly userProfile: UserProfileService,
    private readonly userOps: UserOpsService,
    private readonly invitations: InvitationsService,
  ) {}

  // ── Static GET routes (must be before any :userId parameterized routes) ──

  @RequirePermission("hr:employees:view")
  @Get()
  listUsers(
    @Query(new ZodValidationPipe(listUsersSchema)) query: ListUsersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.listUsers(u.orgId, query);
  }

  @RequirePermission("hr:employees:view")
  @Get("stats")
  getStats(@CurrentUser() u: CurrentUserContext) {
    return this.userOps.getStats(u.orgId);
  }

  @RequirePermission("hr:export:manage")
  @Get("export")
  async exportUsers(@CurrentUser() u: CurrentUserContext, @Res() res: Response) {
    const data = await this.userOps.exportUsers(u.orgId);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=users.csv");
    res.send(data);
  }

  @RequirePermission("hr:employees:manage")
  @Get("invitations")
  listInvitations(
    @Query(new ZodValidationPipe(listInvitationsSchema)) query: ListInvitationsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invitations.listPaginated(u.orgId, {
      page: query.page,
      limit: query.limit,
      includeAccepted: query.includeAccepted,
    });
  }

  @RequirePermission("hr:employees:manage")
  @Get("audit")
  getOrgAuditLog(
    @Query(new ZodValidationPipe(listAuditSchema)) query: ListAuditInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userProfile.getAuditLog(u.orgId, query);
  }

  // ── Static POST routes ──

  @RequirePermission("hr:employees:create")
  @Post()
  createUser(
    @Body(new ZodValidationPipe(createUserSchema)) body: CreateUserInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.createUser(u.orgId, body, { userId: u.userId, isOrgOwner: u.isOrgOwner });
  }

  @RequirePermission("hr:employees:create")
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

  @RequirePermission("hr:employees:create")
  @Post("bulk-invite")
  bulkInvite(
    @Body(new ZodValidationPipe(bulkInviteSchema)) body: BulkInviteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invitations.bulkInvite(u.orgId, { userId: u.userId, isOrgOwner: u.isOrgOwner }, body.emails, body.role);
  }

  @RequirePermission("hr:employees:manage")
  @Post("bulk-suspend")
  @HttpCode(200)
  bulkSuspend(
    @Body(new ZodValidationPipe(bulkActionSchema)) body: BulkActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userOps.bulkSuspend(u.orgId, body.userIds, u.userId);
  }

  @RequirePermission("hr:employees:manage")
  @Post("bulk-archive")
  @HttpCode(200)
  bulkArchive(
    @Body(new ZodValidationPipe(bulkActionSchema)) body: BulkActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userOps.bulkArchive(u.orgId, body.userIds, u.userId);
  }

  @RequirePermission("hr:employees:manage")
  @Post("bulk-restore")
  @HttpCode(200)
  bulkRestore(
    @Body(new ZodValidationPipe(bulkActionSchema)) body: BulkActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userOps.bulkRestore(u.orgId, body.userIds, u.userId);
  }

  @RequirePermission("hr:employees:manage")
  @Post("bulk-update")
  @HttpCode(200)
  bulkUpdate(
    @Body(new ZodValidationPipe(bulkUpdateUsersSchema)) body: BulkUpdateUsersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userOps.bulkUpdateUsers(u.orgId, body, { userId: u.userId, isOrgOwner: u.isOrgOwner });
  }

  @RequirePermission("hr:employees:create")
  @Post("import")
  importUsers(
    @Body(new ZodValidationPipe(z.object({ rows: z.array(importUsersRowSchema).min(1).max(500) })))
    body: { rows: ImportUsersRow[] },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userOps.importUsers(u.orgId, body.rows, { userId: u.userId, isOrgOwner: u.isOrgOwner });
  }

  // ── Invitation sub-routes (static prefix "invitations/") ──

  @RequirePermission("hr:employees:create")
  @Post("invitations/:invitationId/resend")
  @HttpCode(200)
  resendInvite(@Param("invitationId") invitationId: string, @CurrentUser() u: CurrentUserContext) {
    return this.invitations.resend(u.orgId, invitationId, u.userId);
  }

  @RequirePermission("hr:employees:delete")
  @RequirePermission("hr:employees:create")
  @Patch("invitations/:invitationId/role")
  @HttpCode(200)
  changeInviteRole(
    @Param("invitationId") invitationId: string,
    @Body(new ZodValidationPipe(changeInviteRoleSchema)) body: ChangeInviteRoleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invitations.changeRole(
      u.orgId,
      invitationId,
      { userId: u.userId, isOrgOwner: u.isOrgOwner },
      body.role,
    );
  }

  @Delete("invitations/:invitationId")
  cancelInvite(@Param("invitationId") invitationId: string, @CurrentUser() u: CurrentUserContext) {
    return this.invitations.cancel(u.orgId, invitationId, u.userId);
  }

  // ── Parameterized :userId routes (must come after all static routes) ──

  @RequirePermission("hr:employees:view")
  @Get(":userId")
  getUser(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.users.getUser(u.orgId, userId);
  }

  @RequirePermission("hr:employees:update")
  @Patch(":userId")
  updateUser(
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(updateUserSchema)) body: UpdateUserInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.updateUser(u.orgId, userId, body, { userId: u.userId, isOrgOwner: u.isOrgOwner });
  }

  @RequirePermission("hr:employees:manage")
  @Patch(":userId/status")
  updateStatus(
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(updateUserStatusSchema)) body: UpdateUserStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.updateUserStatus(u.orgId, userId, body.status, u.userId, body.reason);
  }

  @RequirePermission("hr:employees:delete")
  @Delete(":userId")
  deleteUser(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.users.deleteUser(u.orgId, userId, u.userId);
  }

  @RequirePermission("hr:employees:manage")
  @Get(":userId/sessions")
  getSessions(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userProfile.getUserSessions(u.orgId, userId);
  }

  @RequirePermission("hr:employees:manage")
  @Delete(":userId/sessions/:sessionId")
  revokeSession(
    @Param("userId") userId: string,
    @Param("sessionId") sessionId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userProfile.revokeSession(u.orgId, userId, sessionId, u.userId);
  }

  @RequirePermission("hr:employees:manage")
  @Delete(":userId/sessions")
  revokeAllSessions(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userProfile.revokeAllSessions(u.orgId, userId, u.userId);
  }

  @RequirePermission("hr:employees:manage")
  @Get(":userId/devices")
  getDevices(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userProfile.getUserDevices(u.orgId, userId);
  }

  @RequirePermission("hr:employees:manage")
  @Delete(":userId/devices/:deviceId")
  removeDevice(
    @Param("userId") userId: string,
    @Param("deviceId") deviceId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userProfile.removeDevice(u.orgId, userId, deviceId, u.userId);
  }

  @RequirePermission("hr:employees:manage")
  @Get(":userId/activity")
  getActivity(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userProfile.getUserActivity(u.orgId, userId);
  }

  @RequirePermission("hr:employees:view")
  @Get(":userId/preferences")
  getPreferences(@Param("userId") userId: string) {
    return this.userProfile.getPreferences(userId);
  }

  @RequirePermission("hr:employees:update")
  @Patch(":userId/preferences")
  updatePreferences(
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(updatePreferencesSchema)) body: UpdatePreferencesInput,
  ) {
    return this.userProfile.updatePreferences(userId, body);
  }

  @RequirePermission("hr:employees:manage")
  @Get(":userId/login-history")
  getLoginHistory(
    @Param("userId") userId: string,
    @Query(new ZodValidationPipe(listLoginHistorySchema)) query: ListLoginHistoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userProfile.getLoginHistory(u.orgId, userId, query);
  }

  @RequirePermission("hr:employees:view")
  @Get(":userId/membership")
  getMembership(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userProfile.getMembership(u.orgId, userId);
  }

  @RequirePermission("hr:employees:update")
  @Patch(":userId/membership")
  updateMembership(
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(updateMembershipSchema)) body: UpdateMembershipInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userProfile.updateMembership(u.orgId, userId, body, u.userId);
  }

  @RequirePermission("hr:employees:manage")
  @Post(":userId/send-signin-link")
  @HttpCode(200)
  sendSigninLink(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userOps.sendSigninLink(u.orgId, userId, u.userId);
  }

  @RequirePermission("hr:employees:manage")
  @Get(":userId/audit")
  getUserAuditLog(
    @Param("userId") userId: string,
    @Query(new ZodValidationPipe(listAuditSchema)) query: ListAuditInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userProfile.getUserAuditLog(u.orgId, userId, query);
  }
}
