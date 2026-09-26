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
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";

import { HrHelpdeskService } from "./hr-helpdesk.service";
import { HrHelpdeskConfigService } from "./hr-helpdesk-config.service";
import { AccessService } from "../../access/access.service";
import { resolveSupportActor } from "./support-actor";
import {
  addCommentSchema,
  createSchema,
  listSchema,
  queueConfigSchema,
  queueParams,
  routingRuleSchema,
  suggestSchema,
  updateTicketSchema,
  type AddCommentInput,
  type CreateInput,
  type ListInput,
  type QueueConfigInput,
  type RoutingRuleInput,
  type SuggestInput,
  type UpdateTicketInput,
} from "./dto/hr-helpdesk.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  helpdeskQueueSummarySchema,
  helpdeskTicketListSchema,
  helpdeskSuggestSchema,
  hrHelpdeskRoutingSchema,
  helpdeskTicketDetailSchema,
  hrHelpdeskCommentSchema,
  successSchema,
} from "./dto/helpdesk-response.schemas";
import type { SupportQueue } from "./lib/support-queues";

const ticketIdParams = z.object({ ticketId: z.coerce.number().int().positive() }).strict();
const ruleIdParams = z.object({ ruleId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/helpdesk")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrHelpdeskController {
  constructor(
    private readonly helpdesk: HrHelpdeskService,
    private readonly config: HrHelpdeskConfigService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @ResponseSchema(helpdeskTicketListSchema)
  @RequirePermission("hr:helpdesk:view")
  @Validate({ query: listSchema })
  async list(
    @Query() filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.list(await resolveSupportActor(this.access, u), filters);
  }

  @Get("suggest")
  @ResponseSchema(helpdeskSuggestSchema)
  @RequirePermission("hr:helpdesk:view")
  @Validate({ query: suggestSchema })
  suggest(
    @Query() input: SuggestInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.suggest(u, input);
  }

  @Get("queues")
  @ResponseSchema(z.array(helpdeskQueueSummarySchema))
  @RequirePermission("hr:helpdesk:view")
  async listQueues(@CurrentUser() u: CurrentUserContext) {
    return this.config.queueSummaries(await resolveSupportActor(this.access, u));
  }

  @Put("queues/:queue")
  @ResponseSchema(helpdeskQueueSummarySchema)
  @RequirePermission("hr:helpdesk:manage")
  @Validate({ params: queueParams, body: queueConfigSchema })
  async configureQueue(
    @Param("queue") queue: SupportQueue,
    @Body() body: QueueConfigInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.config.upsertQueueConfig(await resolveSupportActor(this.access, u), queue, body);
  }

  @Get("routing")
  @ResponseSchema(z.array(hrHelpdeskRoutingSchema))
  @RequirePermission("hr:helpdesk:manage")
  listRouting(@CurrentUser() u: CurrentUserContext) {
    return this.config.listRoutingRules(u.orgId);
  }

  @Get(":ticketId")
  @ResponseSchema(helpdeskTicketDetailSchema)
  @RequirePermission("hr:helpdesk:view")
  @Validate({ params: ticketIdParams })
  async getById(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.getById(await resolveSupportActor(this.access, u), ticketId);
  }

  @Post()
  @ResponseSchema(helpdeskTicketDetailSchema)
  @HttpCode(201)
  @RequirePermission("hr:helpdesk:create")
  @Idempotent("hr.helpdesk.ticket.create")
  @Validate({ body: createSchema })
  create(
    @Body() body: CreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.create(u.orgId, u.userId, body);
  }

  @Patch(":ticketId")
  @ResponseSchema(helpdeskTicketDetailSchema)
  @RequirePermission("hr:helpdesk:view")
  @Validate({ params: ticketIdParams, body: updateTicketSchema })
  async update(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: UpdateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.updateTicket(await resolveSupportActor(this.access, u), ticketId, body);
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
    return this.helpdesk.addComment(await resolveSupportActor(this.access, u), ticketId, body);
  }

  @Post("routing")
  @ResponseSchema(hrHelpdeskRoutingSchema)
  @HttpCode(201)
  @RequirePermission("hr:helpdesk:manage")
  @Validate({ body: routingRuleSchema })
  async upsertRouting(
    @Body() body: RoutingRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.config.upsertRoutingRule(await resolveSupportActor(this.access, u), body);
  }

  @Delete("routing/:ruleId")
  @ResponseSchema(successSchema)
  @RequirePermission("hr:helpdesk:manage")
  @Validate({ params: ruleIdParams })
  async deleteRouting(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.config.deleteRoutingRule(await resolveSupportActor(this.access, u), ruleId);
  }
}
