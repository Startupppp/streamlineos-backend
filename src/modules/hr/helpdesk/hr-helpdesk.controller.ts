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
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  helpdeskTicketListSchema,
  helpdeskSuggestSchema,
  hrHelpdeskRoutingSchema,
  helpdeskTicketDetailSchema,
  helpdeskTicketSchema,
  hrHelpdeskCommentSchema,
  successSchema,
} from "./dto/helpdesk-response.schemas";

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
  @ResponseSchema(helpdeskTicketListSchema)
  @RequirePermission("hr:helpdesk:view")
  @Validate({ query: listSchema })
  async list(
    @Query() filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.list(u.orgId, u.userId, await this.resolveIsAdmin(u), filters);
  }

  @Get("suggest")
  @ResponseSchema(helpdeskSuggestSchema)
  @RequirePermission("hr:helpdesk:view")
  @Validate({ query: suggestSchema })
  suggest(
    @Query() input: SuggestInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.suggest(u.orgId, input);
  }

  @Get("routing")
  @ResponseSchema(z.array(hrHelpdeskRoutingSchema))
  @RequirePermission("hr:helpdesk:manage")
  listRouting(@CurrentUser() u: CurrentUserContext) {
    return this.helpdesk.listRoutingRules(u.orgId);
  }

  @Get(":ticketId")
  @ResponseSchema(helpdeskTicketDetailSchema)
  @RequirePermission("hr:helpdesk:view")
  @Validate({ params: ticketIdParams })
  async getById(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.getById(u.orgId, u.userId, await this.resolveIsAdmin(u), ticketId);
  }

  @Post()
  @ResponseSchema(helpdeskTicketSchema)
  @HttpCode(201)
  @RequirePermission("hr:helpdesk:create")
  @Validate({ body: createSchema })
  create(
    @Body() body: CreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.create(u.orgId, u.userId, body);
  }

  @Patch(":ticketId")
  @ResponseSchema(helpdeskTicketSchema)
  @RequirePermission("hr:helpdesk:manage")
  @Validate({ params: ticketIdParams, body: updateTicketSchema })
  async update(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: UpdateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.updateTicket(u.orgId, u.userId, await this.resolveIsAdmin(u), ticketId, body);
  }

  @Post(":ticketId/comments")
  @ResponseSchema(hrHelpdeskCommentSchema)
  @HttpCode(201)
  @RequirePermission("hr:helpdesk:view")
  @Validate({ params: ticketIdParams, body: addCommentSchema })
  async addComment(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: AddCommentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.addComment(u.orgId, u.userId, await this.resolveIsAdmin(u), ticketId, body);
  }

  @Post("routing")
  @ResponseSchema(hrHelpdeskRoutingSchema)
  @HttpCode(201)
  @RequirePermission("hr:helpdesk:manage")
  @Validate({ body: routingRuleSchema })
  upsertRouting(
    @Body() body: RoutingRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.upsertRoutingRule(u.orgId, body);
  }

  @Delete("routing/:ruleId")
  @ResponseSchema(successSchema)
  @RequirePermission("hr:helpdesk:manage")
  @Validate({ params: ruleIdParams })
  deleteRouting(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.deleteRoutingRule(u.orgId, ruleId);
  }
}
