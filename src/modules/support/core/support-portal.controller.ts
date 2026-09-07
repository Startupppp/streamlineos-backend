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
import { actingMembershipId } from "../../../common/auth/principal";
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
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  portalTicketListSchema,
  portalCustomFieldListSchema,
  portalCreateTicketSchema,
  portalTicketDetailSchema,
  portalMessageSchema,
} from "./dto/support-portal-response.schemas";
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
  @ResponseSchema(portalTicketListSchema)
  listMyTickets(@CurrentUser() u: CurrentUserContext) {
    return this.portal.listMyTickets(u.orgId, u.userId, actingMembershipId(u.principal));
  }

  @Get("custom-fields")
  @RequirePermission("support:portal:tickets:create")
  @ResponseSchema(portalCustomFieldListSchema)
  listActiveCustomFields(@CurrentUser() u: CurrentUserContext) {
    return this.customFields.listFields(u.orgId, true);
  }

  @Post("tickets")
  @Idempotent("support:portal_ticket.create")
  @RequirePermission("support:portal:tickets:create")
  @HttpCode(201)
  @Validate({ body: createPortalTicketSchema })
  @ResponseSchema(portalCreateTicketSchema)
  async createTicket(
    @Body() body: CreatePortalTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const rate = await this.rateLimit.check("support:portal-ticket-create", `${u.orgId}:${u.userId}`);
    if (!rate.allowed) {
      throw new HttpException(
        `Too many tickets submitted. Retry after ${rate.retryAfterSecs}s`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.portal.createTicket(u.orgId, u.userId, actingMembershipId(u.principal), body);
  }

  @Get("tickets/:ticketId")
  @RequirePermission("support:portal:tickets:view")
  @Validate({ params: ticketIdParams })
  @ResponseSchema(portalTicketDetailSchema)
  getMyTicket(@Param("ticketId", ParseIntPipe) ticketId: number, @CurrentUser() u: CurrentUserContext) {
    return this.portal.getMyTicket(u.orgId, u.userId, actingMembershipId(u.principal), ticketId);
  }

  @Post("tickets/:ticketId/messages")
  @Idempotent("support:portal_ticket.reply")
  @RequirePermission("support:portal:tickets:reply")
  @HttpCode(201)
  @Validate({ params: ticketIdParams, body: createPortalMessageSchema })
  @ResponseSchema(portalMessageSchema)
  addMessage(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: CreatePortalMessageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.portal.addMessage(u.orgId, u.userId, actingMembershipId(u.principal), ticketId, body);
  }
}
