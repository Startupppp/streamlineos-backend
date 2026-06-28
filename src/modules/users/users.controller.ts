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
  type ListUsersInput, type UpdateUserInput, type UpdateUserStatusInput,
  type InviteUserInput, type BulkInviteInput, type UpdatePreferencesInput,
} from "./dto/users.schemas";

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
}
