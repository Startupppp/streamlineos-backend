import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
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
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { HrHolidaysService } from "./hr-holidays.service";
import {
  createHolidaySchema,
  holidayCalendarQuerySchema,
  holidayListQuerySchema,
  updateHolidaySchema,
  type CreateHolidayInput,
  type HolidayCalendarQuery,
  type HolidayListQuery,
  type UpdateHolidayInput,
} from "./dto/holidays.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/holidays")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrHolidaysController {
  constructor(private readonly holidays: HrHolidaysService) {}

  @Get()
  @RequirePermission("hr:attendance:view")
  list(
    @Query(new ZodValidationPipe(holidayListQuerySchema)) query: HolidayListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const year = query.year || new Date().getFullYear();
    return this.holidays.listByYear(u.orgId, year);
  }

  @Get("calendar")
  @RequirePermission("hr:attendance:view")
  calendar(
    @Query(new ZodValidationPipe(holidayCalendarQuerySchema)) query: HolidayCalendarQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const year = query.year || new Date().getFullYear();
    const month = query.month || new Date().getMonth() + 1;
    return this.holidays.calendar(u.orgId, year, month);
  }

  @Post()
  @RequirePermission("hr:attendance:manage")
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(createHolidaySchema)) body: CreateHolidayInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.holidays.create(u.orgId, body);
    if (!result.ok) {
      throw new ConflictException("A holiday with this name or date already exists.");
    }
    return { success: true };
  }

  @Patch(":holidayId")
  @RequirePermission("hr:attendance:manage")
  async update(
    @Param("holidayId", ParseIntPipe) holidayId: number,
    @Body(new ZodValidationPipe(updateHolidaySchema)) body: UpdateHolidayInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const existing = await this.holidays.getById(u.orgId, holidayId);
    if (!existing) throw new NotFoundException("Holiday not found.");
    return this.holidays.update(u.orgId, holidayId, body);
  }

  @Delete(":holidayId")
  @HttpCode(204)
  @RequirePermission("hr:attendance:manage")
  async remove(
    @Param("holidayId", ParseIntPipe) holidayId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const existing = await this.holidays.getById(u.orgId, holidayId);
    if (!existing) throw new NotFoundException("Holiday not found.");
    return this.holidays.remove(u.orgId, holidayId);
  }
}
