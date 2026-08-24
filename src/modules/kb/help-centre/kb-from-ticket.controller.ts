import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { KbFromTicketService } from "./kb-from-ticket.service";
import { fromTicketSchema, type FromTicketInput } from "./dto/kb-from-ticket.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbFromTicketController {
  constructor(private readonly fromTicket: KbFromTicketService) {}

  @Post("articles/from-ticket/:ticketId")
  @HttpCode(200)
  @RequirePermission("kb:articles:create")
  async draftFromTicket(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(fromTicketSchema)) body: FromTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.fromTicket.draftFromTicket(u, ticketId, body);
  }
}
