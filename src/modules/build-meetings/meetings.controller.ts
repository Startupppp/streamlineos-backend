import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { MeetingsService } from "./meetings.service";
import {
  addAttendeeSchema,
  createMeetingSchema,
  listMeetingsQuerySchema,
  updateMeetingSchema,
  upsertStandupSchema,
  type AddAttendeeInput,
  type CreateMeetingInput,
  type ListMeetingsQuery,
  type UpdateMeetingInput,
  type UpsertStandupInput,
} from "./dto/meetings.schemas";

@RequireModule("build")
@Controller("build/:projectId/meetings")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class MeetingsController {
  constructor(private readonly svc: MeetingsService) {}

  @Get()
  @RequirePermission("build:meetings:view")
  listMeetings(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query(new ZodValidationPipe(listMeetingsQuerySchema)) query: ListMeetingsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listMeetings(u.orgId, projectId, query);
  }

  @Get(":meetingId")
  @RequirePermission("build:meetings:view")
  getMeeting(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getMeeting(u.orgId, projectId, meetingId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:meetings:manage")
  createMeeting(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createMeetingSchema)) body: CreateMeetingInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createMeeting(u.orgId, u.userId, projectId, body);
  }

  @Patch(":meetingId")
  @RequirePermission("build:meetings:manage")
  updateMeeting(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Body(new ZodValidationPipe(updateMeetingSchema)) body: UpdateMeetingInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateMeeting(u.orgId, u.userId, projectId, meetingId, body);
  }

  @Delete(":meetingId")
  @RequirePermission("build:meetings:manage")
  @HttpCode(204)
  deleteMeeting(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteMeeting(u.orgId, u.userId, projectId, meetingId);
  }

  @Post(":meetingId/attendees")
  @HttpCode(201)
  @RequirePermission("build:meetings:manage")
  addAttendee(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Body(new ZodValidationPipe(addAttendeeSchema)) body: AddAttendeeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.addAttendee(u.orgId, u.userId, projectId, meetingId, body);
  }

  @Delete(":meetingId/attendees/:attendeeUserId")
  @RequirePermission("build:meetings:manage")
  @HttpCode(204)
  removeAttendee(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Param("attendeeUserId") attendeeUserId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.removeAttendee(u.orgId, u.userId, projectId, meetingId, attendeeUserId);
  }

  @Put(":meetingId/standup")
  @RequirePermission("build:meetings:manage")
  upsertStandup(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Body(new ZodValidationPipe(upsertStandupSchema)) body: UpsertStandupInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.upsertStandup(u.orgId, u.userId, projectId, meetingId, body);
  }
}
