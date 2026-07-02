import {
  Controller, Get, Patch, Delete, Post, Param, Query, Body, UseGuards, Res
} from "@nestjs/common";
import { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { UsersService } from "./users.service";
import { UserProfileService } from "./user-profile.service";
import { InvitationsService } from "../organization/invitations.service";
import {
  listUsersSchema, updateUserSchema, updateUserStatusSchema,
  inviteUserSchema, bulkInviteSchema, updatePreferencesSchema,
  updateMembershipSchema, bulkActionSchema, listLoginHistorySchema,
  bulkUpdateUsersSchema, listAuditSchema, importUsersRowSchema, createUserSchema,
  type ListUsersInput, type UpdateUserInput, type UpdateUserStatusInput,
  type InviteUserInput, type BulkInviteInput, type UpdatePreferencesInput,
  type UpdateMembershipInput, type BulkActionInput, type ListLoginHistoryInput,
  type BulkUpdateUsersInput, type ListAuditInput, type ImportUsersRow, type CreateUserInput,
} from "./dto/users.schemas";
import { z } from "zod";

@Controller("users")
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly userProfile: UserProfileService,
    private readonly invitations: InvitationsService,
  ) {}

  // ── Static GET routes (must be before any :userId parameterized routes) ──

  @Get()
  listUsers(
    @Query(new ZodValidationPipe(listUsersSchema)) query: ListUsersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.listUsers(u.orgId, query);
  }

  @Get("stats")
  getStats(@CurrentUser() u: CurrentUserContext) {
    return this.users.getStats(u.orgId);
  }

  @Get("export")
  async exportUsers(@CurrentUser() u: CurrentUserContext, @Res() res: Response) {
    const data = await this.users.exportUsers(u.orgId);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=users.csv");
    res.send(data);
  }

  @Get("invitations")
  listInvitations(
    @Query() query: { page?: string; limit?: string; includeAccepted?: string },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invitations.listPaginated(u.orgId, {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      includeAccepted: query.includeAccepted === "true",
    });
  }

  @Get("audit")
  getOrgAuditLog(
    @Query(new ZodValidationPipe(listAuditSchema)) query: ListAuditInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userProfile.getAuditLog(u.orgId, query);
  }

  // ── Static POST routes ──

  @Post()
  createUser(
    @Body(new ZodValidationPipe(createUserSchema)) body: CreateUserInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.createUser(u.orgId, body, u.userId);
  }

  @Post("invite")
  inviteUser(
    @Body(new ZodValidationPipe(inviteUserSchema)) body: InviteUserInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const { email, role, employeeId, branchId, departmentId, teamId, managerUserId, startDate, welcomeMessage } = body;
    return this.invitations.invite(u.orgId, u.userId, email, role, {
      employeeId, branchId, departmentId, teamId, managerUserId, startDate, welcomeMessage,
    });
  }

  @Post("bulk-invite")
  bulkInvite(
    @Body(new ZodValidationPipe(bulkInviteSchema)) body: BulkInviteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invitations.bulkInvite(u.orgId, u.userId, body.emails, body.role);
  }

  @Post("bulk-suspend")
  bulkSuspend(
    @Body(new ZodValidationPipe(bulkActionSchema)) body: BulkActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.bulkSuspend(u.orgId, body.userIds, u.userId);
  }

  @Post("bulk-archive")
  bulkArchive(
    @Body(new ZodValidationPipe(bulkActionSchema)) body: BulkActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.bulkArchive(u.orgId, body.userIds, u.userId);
  }

  @Post("bulk-restore")
  bulkRestore(
    @Body(new ZodValidationPipe(bulkActionSchema)) body: BulkActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.bulkRestore(u.orgId, body.userIds, u.userId);
  }

  @Post("bulk-update")
  bulkUpdate(
    @Body(new ZodValidationPipe(bulkUpdateUsersSchema)) body: BulkUpdateUsersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.bulkUpdateUsers(u.orgId, body, u.userId);
  }

  @Post("import")
  importUsers(
    @Body(new ZodValidationPipe(z.object({ rows: z.array(importUsersRowSchema).min(1).max(500) })))
    body: { rows: ImportUsersRow[] },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.importUsers(u.orgId, body.rows, u.userId);
  }

  // ── Invitation sub-routes (static prefix "invitations/") ──

  @Post("invitations/:invitationId/resend")
  resendInvite(@Param("invitationId") invitationId: string, @CurrentUser() u: CurrentUserContext) {
    return this.invitations.resend(u.orgId, invitationId, u.userId);
  }

  @Delete("invitations/:invitationId")
  cancelInvite(@Param("invitationId") invitationId: string, @CurrentUser() u: CurrentUserContext) {
    return this.invitations.cancel(u.orgId, invitationId, u.userId);
  }

  // ── Parameterized :userId routes (must come after all static routes) ──

  @Get(":userId")
  getUser(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.users.getUser(u.orgId, userId);
  }

  @Patch(":userId")
  updateUser(
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(updateUserSchema)) body: UpdateUserInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.updateUser(u.orgId, userId, body, u.userId);
  }

  @Patch(":userId/status")
  updateStatus(
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(updateUserStatusSchema)) body: UpdateUserStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.updateUserStatus(u.orgId, userId, body.status, u.userId, body.reason);
  }

  @Delete(":userId")
  deleteUser(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.users.deleteUser(u.orgId, userId, u.userId);
  }

  @Get(":userId/sessions")
  getSessions(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userProfile.getUserSessions(u.orgId, userId);
  }

  @Delete(":userId/sessions/:sessionId")
  revokeSession(
    @Param("userId") userId: string,
    @Param("sessionId") sessionId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userProfile.revokeSession(u.orgId, userId, sessionId, u.userId);
  }

  @Delete(":userId/sessions")
  revokeAllSessions(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userProfile.revokeAllSessions(u.orgId, userId, u.userId);
  }

  @Get(":userId/devices")
  getDevices(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userProfile.getUserDevices(u.orgId, userId);
  }

  @Delete(":userId/devices/:deviceId")
  removeDevice(
    @Param("userId") userId: string,
    @Param("deviceId") deviceId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userProfile.removeDevice(u.orgId, userId, deviceId, u.userId);
  }

  @Get(":userId/activity")
  getActivity(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userProfile.getUserActivity(u.orgId, userId);
  }

  @Get(":userId/preferences")
  getPreferences(@Param("userId") userId: string) {
    return this.userProfile.getPreferences(userId);
  }

  @Patch(":userId/preferences")
  updatePreferences(
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(updatePreferencesSchema)) body: UpdatePreferencesInput,
  ) {
    return this.userProfile.updatePreferences(userId, body);
  }

  @Get(":userId/login-history")
  getLoginHistory(
    @Param("userId") userId: string,
    @Query(new ZodValidationPipe(listLoginHistorySchema)) query: ListLoginHistoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userProfile.getLoginHistory(u.orgId, userId, query);
  }

  @Get(":userId/membership")
  getMembership(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userProfile.getMembership(u.orgId, userId);
  }

  @Patch(":userId/membership")
  updateMembership(
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(updateMembershipSchema)) body: UpdateMembershipInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userProfile.updateMembership(u.orgId, userId, body, u.userId);
  }

  @Post(":userId/reset-password")
  resetPassword(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.users.resetPassword(u.orgId, userId, u.userId);
  }

  @Get(":userId/audit")
  getUserAuditLog(
    @Param("userId") userId: string,
    @Query(new ZodValidationPipe(listAuditSchema)) query: ListAuditInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userProfile.getUserAuditLog(u.orgId, userId, query);
  }
}
