import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { LeavesService } from "./leaves.service";
import {
  leaveCalendarQuerySchema,
  type LeaveCalendarQuery,
} from "./dto/leaves.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { leaveCalendarItemSchema } from "./dto/time-leave-response.schemas";

@RequireModule("hr")
@Controller("hr/leave-calendar")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class LeaveCalendarController {
  constructor(private readonly leaves: LeavesService) {}

  @Get()
  @ResponseSchema(z.array(leaveCalendarItemSchema))
  @RequirePermission("hr:leaves:read")
  @Validate({ query: leaveCalendarQuerySchema })
  calendar(
    @Query() query: LeaveCalendarQuery,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const now = new Date();
    const month = query.month ?? now.getMonth() + 1;
    const year = query.year ?? now.getFullYear();
    if (month < 1 || month > 12) {
      throw new BadRequestException("month must be between 1 and 12");
    }
    return this.leaves.calendar(currentUser.orgId, month, year);
  }
}
