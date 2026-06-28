import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  BadRequestException,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrLeaveBlackoutService } from "./hr-leave-blackout.service";
import {
  blackoutListQuerySchema,
  createBlackoutSchema,
  type BlackoutListQuery,
  type CreateBlackoutInput,
} from "./dto/leave-blackout.schemas";

@Controller("hr/leaves/blackout")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission("hr:leaves:manage")
export class HrLeaveBlackoutController {
  constructor(private readonly blackout: HrLeaveBlackoutService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(blackoutListQuerySchema)) query: BlackoutListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.blackout.list(u.orgId, query);
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createBlackoutSchema)) body: CreateBlackoutInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (body.startDate > body.endDate) {
      throw new BadRequestException("Start date must be on or before end date");
    }
    return this.blackout.create(u.orgId, u.userId, body);
  }

  @Delete(":blackoutId")
  async remove(
    @Param("blackoutId", ParseIntPipe) blackoutId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const existing = await this.blackout.getById(u.orgId, blackoutId);
    if (!existing) throw new NotFoundException("Blackout date not found");
    return this.blackout.remove(blackoutId);
  }
}
