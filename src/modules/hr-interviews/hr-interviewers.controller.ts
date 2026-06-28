import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { HrInterviewersService } from "./hr-interviewers.service";
import { AccessService } from "../access/access.service";

@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard)
export class HrInterviewersController {
  constructor(
    private readonly interviewers: HrInterviewersService,
    private readonly access: AccessService,
  ) {}

  @Get("interviewers/availability")
  availability(
    @Query("date") date: string | undefined,
    @Query("interviewerIds") interviewerIds: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.interviewers.availability(u.orgId, date, interviewerIds);
  }

  @Get("interviewer-performance")
  interviewerPerformance(
    @Query("days") daysParam: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const days = Math.min(Number(daysParam ?? "90"), 365);
    return this.interviewers.interviewerPerformance(u.orgId, days);
  }

  @Get("booking-links")
  listBookingLinks(@CurrentUser() u: CurrentUserContext) {
    return this.interviewers.listBookingLinks(u.orgId);
  }

  @Patch("booking-links/:linkId")
  async cancelBookingLink(
    @Param("linkId", ParseIntPipe) linkId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    const result = await this.interviewers.cancelBookingLink(u.orgId, linkId);
    if (!result) throw new NotFoundException("Booking link not found.");
    return result;
  }
}
