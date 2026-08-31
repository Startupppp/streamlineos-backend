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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RatesService } from "./rates.service";
import {
  createRateSchema,
  updateRateSchema,
  type CreateRateInput,
  type UpdateRateInput,
} from "./dto/rates.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const rateIdParams = z.object({ rateId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("timesheets/rates")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
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
  @Validate({ body: createRateSchema })
  create(
    @Body() body: CreateRateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rates.createRate(u, body);
  }

  @Patch(":rateId")
  @RequirePermission("timesheets:rates:manage")
  @Validate({ params: rateIdParams, body: updateRateSchema })
  update(
    @Param("rateId", ParseIntPipe) rateId: number,
    @Body() body: UpdateRateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rates.updateRate(u, rateId, body);
  }

  @Delete(":rateId")
  @HttpCode(204)
  @RequirePermission("timesheets:rates:manage")
  @Validate({ params: rateIdParams })
  delete(
    @Param("rateId", ParseIntPipe) rateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rates.deleteRate(u, rateId);
  }
}
