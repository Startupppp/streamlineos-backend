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
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import {
  createCalendarEventSchema,
  patchCalendarEventSchema,
  type CreateCalendarEvent,
  type PatchCalendarEvent,
} from "./dto/insights.schemas";
import { CalendarService } from "./calendar.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const eventIdParams = z.object({ eventId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("payroll/calendar")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class CalendarController {
  constructor(private readonly calendarService: CalendarService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:runs:view")
  list(
    @CurrentUser() u: CurrentUserContext,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.calendarService.list(u.orgId, from, to);
  }

  @Post("generate")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:settings:manage")
  generate(@CurrentUser() u: CurrentUserContext, @Query("month") month: string) {
    return this.calendarService.generateMonth(u.orgId, month);
  }

  @Post()
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:settings:manage")
  @Validate({ body: createCalendarEventSchema })
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateCalendarEvent,
  ) {
    return this.calendarService.create(u.orgId, u.userId, body);
  }

  @Patch(":eventId")
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:settings:manage")
  @Validate({ params: eventIdParams, body: patchCalendarEventSchema })
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("eventId", ParseIntPipe) eventId: number,
    @Body() body: PatchCalendarEvent,
  ) {
    return this.calendarService.update(u.orgId, u.userId, eventId, body);
  }

  @Delete(":eventId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:settings:manage")
  @Validate({ params: eventIdParams })
  remove(
    @CurrentUser() u: CurrentUserContext,
    @Param("eventId", ParseIntPipe) eventId: number,
  ) {
    return this.calendarService.remove(u.orgId, u.userId, eventId);
  }
}
