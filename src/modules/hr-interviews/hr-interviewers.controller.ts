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
import { hasRoleOrPrivileged } from "../../common/auth/role-access";
import { HrInterviewersService } from "./hr-interviewers.service";
import { RECRUITMENT_ADMIN_ROLES } from "./recruitment-roles";

@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard)
export class HrInterviewersController {
  constructor(private readonly interviewers: HrInterviewersService) {}

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
    if (!hasRoleOrPrivileged(u, RECRUITMENT_ADMIN_ROLES)) {
      throw new ForbiddenException("Forbidden");
    }
    const result = await this.interviewers.cancelBookingLink(u.orgId, linkId);
    if (!result) throw new NotFoundException("Booking link not found.");
    return result;
  }
}
