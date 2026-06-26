import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrHolidaysService } from "./hr-holidays.service";
import {
  holidayCalendarQuerySchema,
  updateHolidaySchema,
  type HolidayCalendarQuery,
  type UpdateHolidayInput,
} from "./dto/holidays.schemas";

@Controller("hr/holidays")
@UseGuards(JwtAuthGuard)
export class HrHolidaysController {
  constructor(private readonly holidays: HrHolidaysService) {}

  @Get("calendar")
  calendar(
    @Query(new ZodValidationPipe(holidayCalendarQuerySchema)) query: HolidayCalendarQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const year = query.year || new Date().getFullYear();
    const month = query.month || new Date().getMonth() + 1;
    return this.holidays.calendar(u.orgId, year, month);
  }

  @Patch(":holidayId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "hr:attendance")
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
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "hr:attendance")
  async remove(
    @Param("holidayId", ParseIntPipe) holidayId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const existing = await this.holidays.getById(u.orgId, holidayId);
    if (!existing) throw new NotFoundException("Holiday not found.");
    return this.holidays.remove(holidayId);
  }
}
