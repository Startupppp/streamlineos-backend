import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { HrInterviewersService } from "./hr-interviewers.service";
import { RequireModule } from "../../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrInterviewersController {
  constructor(private readonly interviewers: HrInterviewersService) {}

  @Get("interviewers/availability")
  @RequirePermission("hr:interviews:view")
  availability(
    @Query("date") date: string | undefined,
    @Query("interviewerIds") interviewerIds: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.interviewers.availability(u.orgId, date, interviewerIds);
  }

  @Get("interviewer-performance")
  @RequirePermission("hr:interviews:view")
  interviewerPerformance(
    @Query("days") daysParam: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const days = Math.min(Number(daysParam ?? "90"), 365);
    return this.interviewers.interviewerPerformance(u.orgId, days);
  }

  @Get("booking-links")
  @RequirePermission("hr:interviews:view")
  listBookingLinks(@CurrentUser() u: CurrentUserContext) {
    return this.interviewers.listBookingLinks(u.orgId);
  }

  @Patch("booking-links/:linkId")
  @RequirePermission("hr:interviews:manage")
  async cancelBookingLink(
    @Param("linkId", ParseIntPipe) linkId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.interviewers.cancelBookingLink(u.orgId, linkId);
    if (!result) throw new NotFoundException("Booking link not found.");
    return result;
  }
}
