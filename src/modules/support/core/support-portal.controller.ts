import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
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
import { RateLimitService } from "../../../common/ratelimit/rate-limit.service";
import { SupportPortalService } from "./support-portal.service";
import { SupportCustomFieldsService } from "./support-custom-fields.service";
import {
  createPortalMessageSchema,
  createPortalTicketSchema,
  type CreatePortalMessageInput,
  type CreatePortalTicketInput,
} from "./dto/support.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const ticketIdParams = z.object({ ticketId: z.coerce.number().int().positive() }).strict();

@RequireModule("support")
@Controller("support/portal")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SupportPortalController {
  constructor(
    private readonly portal: SupportPortalService,
    private readonly rateLimit: RateLimitService,
    private readonly customFields: SupportCustomFieldsService,
  ) {}

  @Get("tickets")
  @RequirePermission("support:portal:tickets:view")
  listMyTickets(@CurrentUser() u: CurrentUserContext) {
    return this.portal.listMyTickets(u.orgId, u.userId);
  }

  @Get("custom-fields")
  @RequirePermission("support:portal:tickets:create")
  listActiveCustomFields(@CurrentUser() u: CurrentUserContext) {
    return this.customFields.listFields(u.orgId, true);
  }

  @Post("tickets")
  @Idempotent("support:portal_ticket.create")
  @RequirePermission("support:portal:tickets:create")
  @HttpCode(201)
  async createTicket(
    @Body(new ZodValidationPipe(createPortalTicketSchema)) body: CreatePortalTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const rate = await this.rateLimit.check("support:portal-ticket-create", `${u.orgId}:${u.userId}`);
    if (!rate.allowed) {
      throw new HttpException(
        `Too many tickets submitted. Retry after ${rate.retryAfterSecs}s`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.portal.createTicket(u.orgId, u.userId, body);
  }

  @Get("tickets/:ticketId")
  @RequirePermission("support:portal:tickets:view")
  @Validate({ params: ticketIdParams })
  getMyTicket(@Param("ticketId", ParseIntPipe) ticketId: number, @CurrentUser() u: CurrentUserContext) {
    return this.portal.getMyTicket(u.orgId, u.userId, ticketId);
  }

  @Post("tickets/:ticketId/messages")
  @Idempotent("support:portal_ticket.reply")
  @RequirePermission("support:portal:tickets:reply")
  @HttpCode(201)
  @Validate({ params: ticketIdParams })
  addMessage(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(createPortalMessageSchema)) body: CreatePortalMessageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.portal.addMessage(u.orgId, u.userId, ticketId, body);
  }
}
