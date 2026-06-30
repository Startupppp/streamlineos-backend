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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { BroadcastsService } from "./broadcasts.service";
import {
  createBroadcastSchema,
  updateBroadcastSchema,
  listBroadcastsSchema,
  type CreateBroadcastInput,
  type UpdateBroadcastInput,
  type ListBroadcastsInput,
} from "./dto/broadcast.schemas";

@Controller("broadcasts")
@UseGuards(JwtAuthGuard)
export class BroadcastsController {
  constructor(private readonly broadcastsService: BroadcastsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(listBroadcastsSchema)) filters: ListBroadcastsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.broadcastsService.list(u.orgId, filters);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createBroadcastSchema)) dto: CreateBroadcastInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.broadcastsService.create(u.orgId, u.userId, dto);
  }

  @Patch(":broadcastId")
  update(
    @Param("broadcastId", ParseIntPipe) broadcastId: number,
    @Body(new ZodValidationPipe(updateBroadcastSchema)) dto: UpdateBroadcastInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.broadcastsService.update(u.orgId, u.userId, broadcastId, dto);
  }

  @Post(":broadcastId/publish")
  publish(
    @Param("broadcastId", ParseIntPipe) broadcastId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.broadcastsService.publish(u.orgId, u.userId, broadcastId);
  }

  @Post(":broadcastId/cancel")
  cancel(
    @Param("broadcastId", ParseIntPipe) broadcastId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.broadcastsService.cancel(u.orgId, u.userId, broadcastId);
  }

  @Delete(":broadcastId")
  remove(
    @Param("broadcastId", ParseIntPipe) broadcastId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.broadcastsService.remove(u.orgId, u.userId, broadcastId);
  }
}
