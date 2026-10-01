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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  meetingListPageSchema,
  meetingDetailSchema,
  meetingSchema,
  addAttendeeResultSchema,
  standupEntrySchema,
} from "./dto/meetings-response.schemas";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();
const projectAndMeetingIdParams = z.object({ projectId: z.coerce.number().int().positive(), meetingId: z.coerce.number().int().positive() }).strict();
const projectMeetingAndAttendeeParams = z.object({ projectId: z.coerce.number().int().positive(), meetingId: z.coerce.number().int().positive(), attendeeUserId: z.string().min(1) }).strict();

@RequireModule("build")
@Controller("build/:projectId/meetings")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class MeetingsController {
  constructor(private readonly svc: MeetingsService) {}

  @Get()
  @RequirePermission("build:meetings:view")
  @ResponseSchema(meetingListPageSchema)
  @Validate({ params: projectIdParams, query: listMeetingsQuerySchema })
  listMeetings(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: ListMeetingsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listMeetings(u, projectId, query);
  }

  @Get(":meetingId")
  @RequirePermission("build:meetings:view")
  @ResponseSchema(meetingDetailSchema)
  @Validate({ params: projectAndMeetingIdParams })
  getMeeting(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getMeeting(u, projectId, meetingId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:meetings:manage")
  @ResponseSchema(meetingSchema)
  @Validate({ params: projectIdParams, body: createMeetingSchema })
  createMeeting(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateMeetingInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createMeeting(u, projectId, body);
  }

  @Patch(":meetingId")
  @RequirePermission("build:meetings:manage")
  @ResponseSchema(meetingSchema)
  @Validate({ params: projectAndMeetingIdParams, body: updateMeetingSchema })
  updateMeeting(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Body() body: UpdateMeetingInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateMeeting(u, projectId, meetingId, body);
  }

  @Delete(":meetingId")
  @RequirePermission("build:meetings:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectAndMeetingIdParams })
  deleteMeeting(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteMeeting(u, projectId, meetingId);
  }

  @Post(":meetingId/attendees")
  @HttpCode(201)
  @RequirePermission("build:meetings:manage")
  @ResponseSchema(addAttendeeResultSchema)
  @Validate({ params: projectAndMeetingIdParams, body: addAttendeeSchema })
  addAttendee(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Body() body: AddAttendeeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.addAttendee(u, projectId, meetingId, body);
  }

  @Delete(":meetingId/attendees/:attendeeUserId")
  @RequirePermission("build:meetings:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectMeetingAndAttendeeParams })
  removeAttendee(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Param("attendeeUserId") attendeeUserId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.removeAttendee(u, projectId, meetingId, attendeeUserId);
  }

  @Put(":meetingId/standup")
  @RequirePermission("build:meetings:manage")
  @ResponseSchema(standupEntrySchema)
  @Validate({ params: projectAndMeetingIdParams, body: upsertStandupSchema })
  upsertStandup(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Body() body: UpsertStandupInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.upsertStandup(u, projectId, meetingId, body);
  }
}
