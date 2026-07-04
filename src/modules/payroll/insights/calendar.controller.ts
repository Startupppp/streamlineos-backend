import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { CalendarService } from "./calendar.service";

@Controller("payroll/calendar")
@UseGuards(JwtAuthGuard)
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
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:settings:manage")
  generate(@CurrentUser() u: CurrentUserContext, @Query("month") month: string) {
    return this.calendarService.generateMonth(u.orgId, month);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:settings:manage")
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: { type: string; date: string; title: string; month?: string },
  ) {
    return this.calendarService.create(u.orgId, u.userId, body);
  }

  @Patch(":eventId")
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:settings:manage")
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("eventId", ParseIntPipe) eventId: number,
    @Body() body: { type?: string; date?: string; title?: string; month?: string },
  ) {
    return this.calendarService.update(u.orgId, eventId, body);
  }

  @Delete(":eventId")
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:settings:manage")
  remove(
    @CurrentUser() u: CurrentUserContext,
    @Param("eventId", ParseIntPipe) eventId: number,
  ) {
    return this.calendarService.remove(u.orgId, eventId);
  }
}
