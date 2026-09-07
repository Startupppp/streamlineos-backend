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
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { DealsMeetingsService } from "./deals-meetings.service";
import {
  createMeetingSchema,
  updateMeetingSchema,
  type CreateMeetingInput,
  type UpdateMeetingInput,
} from "./dto/deals.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema, NoContentResponse } from "../../common/openapi/zod-operation-contracts";
import { dealMeetingSchema } from "./dto/deals-response.schemas";

const dealIdParams = z.object({ dealId: z.coerce.number().int().positive() }).strict();
const dealIdmeetingIdParams = z.object({ dealId: z.coerce.number().int().positive(), meetingId: z.coerce.number().int().positive() }).strict();

@RequireModule("crm")
@Controller("deals")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class DealsMeetingsController {
  constructor(private readonly meetings: DealsMeetingsService) {}

  @Get(":dealId/meetings")
  @RequirePermission("crm:deals:read")
  @ResponseSchema(z.array(dealMeetingSchema))
  @Validate({ params: dealIdParams })
  listMeetings(
    @Param("dealId", ParseIntPipe) dealId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.meetings.listMeetings(u.orgId, dealId);
  }

  @Post(":dealId/meetings")
  @RequirePermission("crm:deals:update")
  @HttpCode(201)
  @ResponseSchema(dealMeetingSchema)
  @Validate({ params: dealIdParams, body: createMeetingSchema })
  createMeeting(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Body() body: CreateMeetingInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.meetings.createMeeting(u.orgId, u.userId, dealId, body);
  }

  @Patch(":dealId/meetings/:meetingId")
  @RequirePermission("crm:deals:update")
  @ResponseSchema(dealMeetingSchema)
  @Validate({ params: dealIdmeetingIdParams, body: updateMeetingSchema })
  updateMeeting(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Body() body: UpdateMeetingInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.meetings.updateMeeting(u.orgId, dealId, meetingId, body);
  }

  @Delete(":dealId/meetings/:meetingId")
  @HttpCode(204)
  @RequirePermission("crm:deals:update")
  @NoContentResponse()
  @Validate({ params: dealIdmeetingIdParams })
  async deleteMeeting(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.meetings.deleteMeeting(u.orgId, dealId, meetingId);
  }
}
