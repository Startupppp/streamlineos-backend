import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { HrHelpdeskService } from "./hr-helpdesk.service";
import {
  addCommentSchema,
  createSchema,
  myRequestsListSchema,
  suggestSchema,
  type AddCommentInput,
  type CreateInput,
  type MyRequestsListInput,
  type SuggestInput,
} from "./dto/hr-helpdesk.schemas";
import {
  helpdeskSuggestSchema,
  helpdeskTicketDetailSchema,
  helpdeskTicketListSchema,
  hrHelpdeskCommentSchema,
} from "./dto/helpdesk-response.schemas";

const ticketIdParams = z.object({ ticketId: z.coerce.number().int().positive() }).strict();

@Controller("me/support")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EmployeeSupportController {
  constructor(private readonly helpdesk: HrHelpdeskService) {}

  @Get()
  @ResponseSchema(helpdeskTicketListSchema)
  @RequirePermission("self:support")
  @Validate({ query: myRequestsListSchema })
  list(@Query() filters: MyRequestsListInput, @CurrentUser() u: CurrentUserContext) {
    return this.helpdesk.listMine(u.orgId, u.userId, filters);
  }

  @Get("suggest")
  @ResponseSchema(helpdeskSuggestSchema)
  @RequirePermission("self:support")
  @Validate({ query: suggestSchema })
  suggest(@Query() input: SuggestInput, @CurrentUser() u: CurrentUserContext) {
    return this.helpdesk.suggest(u, input);
  }

  @Get(":ticketId")
  @ResponseSchema(helpdeskTicketDetailSchema)
  @RequirePermission("self:support")
  @Validate({ params: ticketIdParams })
  getById(@Param("ticketId", ParseIntPipe) ticketId: number, @CurrentUser() u: CurrentUserContext) {
    return this.helpdesk.getMine(u.orgId, u.userId, ticketId);
  }

  @Post()
  @ResponseSchema(helpdeskTicketDetailSchema)
  @HttpCode(201)
  @RequirePermission("self:support")
  @Idempotent("self.support.request.create")
  @Validate({ body: createSchema })
  create(@Body() body: CreateInput, @CurrentUser() u: CurrentUserContext) {
    return this.helpdesk.create(u.orgId, u.userId, body);
  }

  @Post(":ticketId/comments")
  @ResponseSchema(hrHelpdeskCommentSchema)
  @HttpCode(201)
  @RequirePermission("self:support")
  @Validate({ params: ticketIdParams, body: addCommentSchema })
  addComment(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: AddCommentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.addMyComment(u.orgId, u.userId, actingMembershipId(u.principal), ticketId, body);
  }
}
