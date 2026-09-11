import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { HrCalendarService } from "./hr-calendar.service";
import { hrCalendarSchema, type HrCalendarInput } from "./dto/hr-calendar.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { z } from "zod";
import { hrCalendarEventSchema } from "./dto/helpdesk-response.schemas";

@RequireModule("hr")
@Controller("hr/calendar")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrCalendarController {
  constructor(private readonly calendarSvc: HrCalendarService) {}

  @Get()
  @ResponseSchema(z.array(hrCalendarEventSchema))
  @RequirePermission("hr:helpdesk:view")
  @Validate({ query: hrCalendarSchema })
  getEvents(
    @Query() input: HrCalendarInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.calendarSvc.getEvents(u, input);
  }
}
