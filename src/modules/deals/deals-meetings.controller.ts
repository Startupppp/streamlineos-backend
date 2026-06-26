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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { DealsMeetingsService } from "./deals-meetings.service";
import {
  createMeetingSchema,
  updateMeetingSchema,
  type CreateMeetingInput,
  type UpdateMeetingInput,
} from "./dto/deals.schemas";

@Controller("deals")
@UseGuards(JwtAuthGuard)
export class DealsMeetingsController {
  constructor(private readonly meetings: DealsMeetingsService) {}

  @Get(":dealId/meetings")
  listMeetings(
    @Param("dealId", ParseIntPipe) dealId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.meetings.listMeetings(u.orgId, dealId);
  }

  @Post(":dealId/meetings")
  @HttpCode(201)
  createMeeting(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Body(new ZodValidationPipe(createMeetingSchema)) body: CreateMeetingInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.meetings.createMeeting(u.orgId, u.userId, dealId, body);
  }

  @Patch(":dealId/meetings/:meetingId")
  updateMeeting(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Body(new ZodValidationPipe(updateMeetingSchema)) body: UpdateMeetingInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.meetings.updateMeeting(u.orgId, dealId, meetingId, body);
  }

  @Delete(":dealId/meetings/:meetingId")
  deleteMeeting(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.meetings.deleteMeeting(u.orgId, dealId, meetingId);
  }
}
