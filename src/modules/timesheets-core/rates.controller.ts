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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RatesService } from "./rates.service";
import {
  createRateSchema,
  updateRateSchema,
  type CreateRateInput,
  type UpdateRateInput,
} from "./dto/rates.schemas";

@Controller("timesheets/rates")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RatesController {
  constructor(private readonly rates: RatesService) {}

  @Get()
  @RequirePermission("timesheets:rates:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.rates.listRates(u);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("timesheets:rates:manage")
  create(
    @Body(new ZodValidationPipe(createRateSchema)) body: CreateRateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rates.createRate(u, body);
  }

  @Patch(":rateId")
  @RequirePermission("timesheets:rates:manage")
  update(
    @Param("rateId", ParseIntPipe) rateId: number,
    @Body(new ZodValidationPipe(updateRateSchema)) body: UpdateRateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rates.updateRate(u, rateId, body);
  }

  @Delete(":rateId")
  @HttpCode(204)
  @RequirePermission("timesheets:rates:manage")
  delete(
    @Param("rateId", ParseIntPipe) rateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rates.deleteRate(u, rateId);
  }
}
