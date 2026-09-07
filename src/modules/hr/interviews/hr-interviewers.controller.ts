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
import { Validate } from "../../../common/validation/validate.decorator";
import { HrInterviewersService } from "./hr-interviewers.service";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import {
  interviewerAvailabilityQuerySchema,
  interviewerPerformanceQuerySchema,
  type InterviewerAvailabilityQuery,
  type InterviewerPerformanceQuery,
} from "./dto/hr-interviews.schemas";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  availabilityResponseSchema,
  interviewerPerformanceSchema,
  bookingLinkWithRelationsSchema,
  bookingCancelResponseSchema,
} from "./dto/interviews-response.schemas";

const linkIdParams = z.object({ linkId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrInterviewersController {
  constructor(private readonly interviewers: HrInterviewersService) {}

  @Get("interviewers/availability")
  @ResponseSchema(availabilityResponseSchema)
  @RequirePermission("hr:interviews:view")
  @Validate({ query: interviewerAvailabilityQuerySchema })
  availability(
    @Query() query: InterviewerAvailabilityQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.interviewers.availability(u.orgId, query.date, query.interviewerIds);
  }

  @Get("interviewer-performance")
  @ResponseSchema(interviewerPerformanceSchema)
  @RequirePermission("hr:interviews:view")
  @Validate({ query: interviewerPerformanceQuerySchema })
  interviewerPerformance(
    @Query() query: InterviewerPerformanceQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const days = Math.min(query.days ?? 90, 365);
    return this.interviewers.interviewerPerformance(u.orgId, days);
  }

  @Get("booking-links")
  @ResponseSchema(z.array(bookingLinkWithRelationsSchema))
  @RequirePermission("hr:interviews:view")
  listBookingLinks(@CurrentUser() u: CurrentUserContext) {
    return this.interviewers.listBookingLinks(u.orgId);
  }

  @Patch("booking-links/:linkId")
  @BodylessAction()
  @ResponseSchema(bookingCancelResponseSchema)
  @RequirePermission("hr:interviews:manage")
  @Validate({ params: linkIdParams })
  async cancelBookingLink(
    @Param("linkId", ParseIntPipe) linkId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.interviewers.cancelBookingLink(u.orgId, linkId);
    if (!result) throw new NotFoundException("Booking link not found.");
    return result;
  }
}
