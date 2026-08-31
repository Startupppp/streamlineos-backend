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
import { KbFromTicketService } from "./kb-from-ticket.service";
import { fromTicketSchema, type FromTicketInput } from "./dto/kb-from-ticket.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const ticketIdParams = z.object({ ticketId: z.coerce.number().int().positive() }).strict();

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbFromTicketController {
  constructor(private readonly fromTicket: KbFromTicketService) {}

  @Post("articles/from-ticket/:ticketId")
  @HttpCode(200)
  @RequirePermission("kb:articles:create")
  @Validate({ params: ticketIdParams, body: fromTicketSchema })
  async draftFromTicket(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: FromTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.fromTicket.draftFromTicket(u, ticketId, body);
  }
}
