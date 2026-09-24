import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { ChangeRequestAffectedItemsService } from "./change-request-affected-items.service";
import {
  linkAffectedTicketSchema,
  listAffectedTicketsQuerySchema,
  type LinkAffectedTicketInput,
  type ListAffectedTicketsQuery,
} from "./dto/change-request-affected-items.schemas";
import {
  changeRequestAffectedItemListPageSchema,
  changeRequestAffectedItemSchema,
} from "./dto/change-request-affected-items-response.schemas";

const projectAndChangeRequestIdParams = z
  .object({
    projectId: z.coerce.number().int().positive(),
    changeRequestId: z.coerce.number().int().positive(),
  })
  .strict();

const affectedItemParams = z
  .object({
    projectId: z.coerce.number().int().positive(),
    changeRequestId: z.coerce.number().int().positive(),
    affectedItemId: z.coerce.number().int().positive(),
  })
  .strict();

@RequireModule("build")
@Controller("build/:projectId/change-requests/:changeRequestId/affected-tickets")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChangeRequestAffectedItemsController {
  constructor(private readonly svc: ChangeRequestAffectedItemsService) {}

  @Get()
  @RequirePermission("build:changerequests:view")
  @ResponseSchema(changeRequestAffectedItemListPageSchema)
  @Validate({ params: projectAndChangeRequestIdParams, query: listAffectedTicketsQuerySchema })
  listAffectedTickets(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("changeRequestId", ParseIntPipe) changeRequestId: number,
    @Query() query: ListAffectedTicketsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listAffectedTickets(u, projectId, changeRequestId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:changerequests:manage")
  @Idempotent("build.change_request.link_ticket")
  @ResponseSchema(changeRequestAffectedItemSchema)
  @Validate({ params: projectAndChangeRequestIdParams, body: linkAffectedTicketSchema })
  linkTicket(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("changeRequestId", ParseIntPipe) changeRequestId: number,
    @Body() body: LinkAffectedTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.linkTicket(u, projectId, changeRequestId, body);
  }

  @Delete(":affectedItemId")
  @HttpCode(204)
  @RequirePermission("build:changerequests:manage")
  @NoContentResponse()
  @Validate({ params: affectedItemParams })
  unlinkTicket(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("changeRequestId", ParseIntPipe) changeRequestId: number,
    @Param("affectedItemId", ParseIntPipe) affectedItemId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.unlinkTicket(u, projectId, changeRequestId, affectedItemId);
  }
}
