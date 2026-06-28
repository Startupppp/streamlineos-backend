import {
  Controller, Get, Patch, Delete, Post, Param, Query, Body, UseGuards, Res
} from "@nestjs/common";
import { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { UsersService } from "./users.service";
import {
  listUsersSchema, updateUserSchema, updateUserStatusSchema,
  inviteUserSchema, bulkInviteSchema, updatePreferencesSchema,
  updateMembershipSchema, bulkActionSchema, listLoginHistorySchema,
  bulkUpdateUsersSchema, listAuditSchema, importUsersRowSchema,
  type ListUsersInput, type UpdateUserInput, type UpdateUserStatusInput,
  type InviteUserInput, type BulkInviteInput, type UpdatePreferencesInput,
  type UpdateMembershipInput, type BulkActionInput, type ListLoginHistoryInput,
  type BulkUpdateUsersInput, type ListAuditInput, type ImportUsersRow,
} from "./dto/users.schemas";
import { z } from "zod";

@Controller("users")
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

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

  @Post("invite")
  inviteUser(
    @Body(new ZodValidationPipe(inviteUserSchema)) body: InviteUserInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.inviteUser(u.orgId, body.email, body.role, u.userId);
  }

  @Post("bulk-invite")
  bulkInvite(
    @Body(new ZodValidationPipe(bulkInviteSchema)) body: BulkInviteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.bulkInvite(u.orgId, body.emails, body.role, u.userId);
  }

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
    return this.users.getUserSessions(u.orgId, userId);
  }

  @Delete(":userId/sessions/:sessionId")
  revokeSession(
    @Param("userId") userId: string,
    @Param("sessionId") sessionId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.revokeSession(u.orgId, userId, sessionId, u.userId);
  }

  @Delete(":userId/sessions")
  revokeAllSessions(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.users.revokeAllSessions(u.orgId, userId, u.userId);
  }

  @Get(":userId/devices")
  getDevices(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.users.getUserDevices(u.orgId, userId);
  }

  @Delete(":userId/devices/:deviceId")
  removeDevice(
    @Param("userId") userId: string,
    @Param("deviceId") deviceId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.removeDevice(u.orgId, userId, deviceId, u.userId);
  }

  @Get(":userId/activity")
  getActivity(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.users.getUserActivity(u.orgId, userId);
  }

  @Get(":userId/preferences")
  getPreferences(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.users.getPreferences(userId);
  }

  @Patch(":userId/preferences")
  updatePreferences(
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(updatePreferencesSchema)) body: UpdatePreferencesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.updatePreferences(userId, body);
  }

  @Get(":userId/login-history")
  getLoginHistory(
    @Param("userId") userId: string,
    @Query(new ZodValidationPipe(listLoginHistorySchema)) query: ListLoginHistoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.getLoginHistory(u.orgId, userId, query);
  }

  @Get(":userId/membership")
  getMembership(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.users.getMembership(u.orgId, userId);
  }

  @Patch(":userId/membership")
  updateMembership(
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(updateMembershipSchema)) body: UpdateMembershipInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.updateMembership(u.orgId, userId, body, u.userId);
  }

  @Get("invitations")
  listInvitations(
    @Query() query: { page?: string; limit?: string; includeAccepted?: string },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.getInvitations(u.orgId, {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      includeAccepted: query.includeAccepted === "true",
    });
  }

  @Post("invitations/:invitationId/resend")
  resendInvite(@Param("invitationId") invitationId: string, @CurrentUser() u: CurrentUserContext) {
    return this.users.resendInvite(u.orgId, invitationId, u.userId);
  }

  @Delete("invitations/:invitationId")
  cancelInvite(@Param("invitationId") invitationId: string, @CurrentUser() u: CurrentUserContext) {
    return this.users.cancelInvite(u.orgId, invitationId, u.userId);
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

  @Post("import")
  importUsers(
    @Body(new ZodValidationPipe(z.object({ rows: z.array(importUsersRowSchema).min(1).max(500) })))
    body: { rows: ImportUsersRow[] },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.importUsers(u.orgId, body.rows, u.userId);
  }

  @Post("bulk-update")
  bulkUpdate(
    @Body(new ZodValidationPipe(bulkUpdateUsersSchema)) body: BulkUpdateUsersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.bulkUpdateUsers(u.orgId, body, u.userId);
  }

  @Post(":userId/reset-password")
  resetPassword(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.users.resetPassword(u.orgId, userId, u.userId);
  }

  @Get("audit")
  getOrgAuditLog(
    @Query(new ZodValidationPipe(listAuditSchema)) query: ListAuditInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.getAuditLog(u.orgId, query);
  }

  @Get(":userId/audit")
  getUserAuditLog(
    @Param("userId") userId: string,
    @Query(new ZodValidationPipe(listAuditSchema)) query: ListAuditInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.getUserAuditLog(u.orgId, userId, query);
  }
}
