import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  holidayListResponseSchema,
  createHolidayResponseSchema,
} from "./dto/organization-core-response.schemas";
import { OrgHolidaysService } from "./org-holidays.service";
import { createHolidaySchema, type CreateHolidayInput } from "./dto/organization.schemas";
import { z } from "zod";

const holidayIdParams = z.object({ holidayId: z.string().min(1) }).strict();

@Controller("organization")
@UseGuards(JwtAuthGuard)
export class OrganizationHolidaysController {
  constructor(private readonly holidays: OrgHolidaysService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission("settings:view")
  @Get("holidays")
  @ResponseSchema(holidayListResponseSchema)
  listHolidays(@CurrentUser() u: CurrentUserContext) {
    return this.holidays.listHolidays(u.orgId);
  }

  @Post("holidays")
  @ResponseSchema(createHolidayResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  @Validate({ body: createHolidaySchema })
  createHoliday(
    @Body() body: CreateHolidayInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.holidays.createHoliday(u.orgId, u.userId, body);
  }

  @Delete("holidays/:holidayId")
  @NoContentResponse()
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  @Validate({ params: holidayIdParams })
  async deleteHoliday(@Param("holidayId") holidayId: string, @CurrentUser() u: CurrentUserContext): Promise<void> {
    await this.holidays.deleteHoliday(u.orgId, u.userId, holidayId);
  }
}
