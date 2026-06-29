import {
  Body,
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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { CalendarConnectionsService } from "./calendar-connections.service";
import {
  createEventSchema,
  exchangeOAuthCodeSchema,
  freeBusySchema,
  upsertConnectionSchema,
  type CreateEventInput,
  type ExchangeOAuthCodeInput,
  type FreeBusyInput,
  type UpsertConnectionInput,
} from "./dto/calendar-connections.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("calendar")
@Controller("calendar/connections")
@UseGuards(JwtAuthGuard)
export class CalendarConnectionsController {
  constructor(private readonly service: CalendarConnectionsService) {}

  @Get()
  getConnections(@CurrentUser() u: CurrentUserContext) {
    return this.service.getConnections(u.userId);
  }

  @Post("oauth/exchange")
  @HttpCode(200)
  async exchangeOAuthCode(
    @Body(new ZodValidationPipe(exchangeOAuthCodeSchema)) body: ExchangeOAuthCodeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.exchangeOAuthCode(u.userId, body);
    return { success: true };
  }

  @Post()
  @HttpCode(200)
  upsertConnection(
    @Body(new ZodValidationPipe(upsertConnectionSchema)) body: UpsertConnectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.upsertConnection(u.userId, body);
  }

  @Delete(":connectionId")
  async disconnect(
    @Param("connectionId", ParseIntPipe) connectionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const removed = await this.service.disconnect(connectionId, u.userId);
    if (!removed) throw new NotFoundException("Calendar connection not found");
    return { success: true };
  }

  @Patch(":connectionId/primary")
  async setPrimary(
    @Param("connectionId", ParseIntPipe) connectionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.service.setPrimary(connectionId, u.userId);
    if (!updated) throw new NotFoundException("Calendar connection not found");
    return { success: true };
  }

  @Get("free-busy")
  getFreeBusy(
    @Query(new ZodValidationPipe(freeBusySchema)) query: FreeBusyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getFreeBusy(u.userId, new Date(query.timeMin), new Date(query.timeMax));
  }

  @Post("events")
  @HttpCode(200)
  createEvent(
    @Body(new ZodValidationPipe(createEventSchema)) body: CreateEventInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createEvent(u.userId, body);
  }
}
