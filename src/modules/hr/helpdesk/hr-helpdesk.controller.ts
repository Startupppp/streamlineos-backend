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
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { HrHelpdeskService } from "./hr-helpdesk.service";
import { AccessService } from "../../access/access.service";
import {
  addCommentSchema,
  createSchema,
  listSchema,
  routingRuleSchema,
  suggestSchema,
  updateTicketSchema,
  type AddCommentInput,
  type CreateInput,
  type ListInput,
  type RoutingRuleInput,
  type SuggestInput,
  type UpdateTicketInput,
} from "./dto/hr-helpdesk.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const ticketIdParams = z.object({ ticketId: z.coerce.number().int().positive() }).strict();
const ruleIdParams = z.object({ ruleId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/helpdesk")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrHelpdeskController {
  constructor(
    private readonly helpdesk: HrHelpdeskService,
    private readonly access: AccessService,
  ) {}

  private async resolveIsAdmin(u: CurrentUserContext): Promise<boolean> {
    if (u.isOrgOwner) return true;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    return perms.has("hr:helpdesk:manage");
  }

  @Get()
  @RequirePermission("hr:helpdesk:view")
  async list(
    @Query(new ZodValidationPipe(listSchema)) filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.list(u.orgId, u.userId, await this.resolveIsAdmin(u), filters);
  }

  @Get("suggest")
  @RequirePermission("hr:helpdesk:view")
  suggest(
    @Query(new ZodValidationPipe(suggestSchema)) input: SuggestInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.suggest(u.orgId, input);
  }

  @Get("routing")
  @RequirePermission("hr:helpdesk:manage")
  listRouting(@CurrentUser() u: CurrentUserContext) {
    return this.helpdesk.listRoutingRules(u.orgId);
  }

  @Get(":ticketId")
  @RequirePermission("hr:helpdesk:view")
  @Validate({ params: ticketIdParams })
  async getById(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.getById(u.orgId, u.userId, await this.resolveIsAdmin(u), ticketId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:helpdesk:create")
  create(
    @Body(new ZodValidationPipe(createSchema)) body: CreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.create(u.orgId, u.userId, body);
  }

  @Patch(":ticketId")
  @RequirePermission("hr:helpdesk:manage")
  @Validate({ params: ticketIdParams })
  async update(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(updateTicketSchema)) body: UpdateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.updateTicket(u.orgId, u.userId, await this.resolveIsAdmin(u), ticketId, body);
  }

  @Post(":ticketId/comments")
  @HttpCode(201)
  @RequirePermission("hr:helpdesk:view")
  @Validate({ params: ticketIdParams })
  async addComment(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(addCommentSchema)) body: AddCommentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.addComment(u.orgId, u.userId, await this.resolveIsAdmin(u), ticketId, body);
  }

  @Post("routing")
  @HttpCode(201)
  @RequirePermission("hr:helpdesk:manage")
  upsertRouting(
    @Body(new ZodValidationPipe(routingRuleSchema)) body: RoutingRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.upsertRoutingRule(u.orgId, body);
  }

  @Delete("routing/:ruleId")
  @RequirePermission("hr:helpdesk:manage")
  @Validate({ params: ruleIdParams })
  deleteRouting(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.deleteRoutingRule(u.orgId, ruleId);
  }
}
