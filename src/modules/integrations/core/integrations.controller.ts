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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { IntegrationsService } from "./integrations.service";
import { OrgConnectionsService } from "./org-connections.service";
import {
  finalizeConnectionSchema,
  initiateConnectionSchema,
  type FinalizeConnectionInput,
  type InitiateConnectionInput,
} from "./dto/integrations.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  integrationsListResponseSchema,
  integrationsInitiateResponseSchema,
  integrationsFinalizeResponseSchema,
  integrationsDisconnectResponseSchema,
  integrationsSetPrimaryResponseSchema,
} from "./dto/integrations-response.schemas";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const connectionIdParams = z.object({ connectionId: z.coerce.number().int().positive() }).strict();

@Controller("integrations")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly orgConnections: OrgConnectionsService,
  ) {}

  @Get("connections")
  @ResponseSchema(integrationsListResponseSchema)
  @RequirePermission("integrations:connections:view")
  listConnections(@CurrentUser() u: CurrentUserContext) {
    return this.integrations.listConnections(u.orgId, u.userId, actingMembershipId(u.principal));
  }

  @Post("connections/initiate")
  @HttpCode(200)
  @ResponseSchema(integrationsInitiateResponseSchema)
  @RequirePermission("integrations:connections:manage")
  @Validate({ body: initiateConnectionSchema })
  initiate(
    @Body() body: InitiateConnectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.integrations.initiate(u.userId, body.toolkit, body.returnPath);
  }

  @Post("connections/finalize")
  @HttpCode(200)
  @ResponseSchema(integrationsFinalizeResponseSchema)
  @RequirePermission("integrations:connections:manage")
  @Validate({ body: finalizeConnectionSchema })
  finalize(
    @Body() body: FinalizeConnectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.integrations.finalize(u.orgId, u.userId, body.connectedAccountId, actingMembershipId(u.principal));
  }

  @Get("connections/org")
  @ResponseSchema(integrationsListResponseSchema)
  @RequirePermission("integrations:connections:manage")
  listOrgConnections(@CurrentUser() u: CurrentUserContext) {
    return this.orgConnections.list(u);
  }

  @Post("connections/org/initiate")
  @HttpCode(200)
  @ResponseSchema(integrationsInitiateResponseSchema)
  @RequirePermission("integrations:connections:manage")
  @Validate({ body: initiateConnectionSchema })
  initiateOrgConnection(
    @Body() body: InitiateConnectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgConnections.initiate(u, body.toolkit, body.returnPath);
  }

  @Post("connections/org/finalize")
  @HttpCode(200)
  @ResponseSchema(integrationsFinalizeResponseSchema)
  @RequirePermission("integrations:connections:manage")
  @Validate({ body: finalizeConnectionSchema })
  finalizeOrgConnection(
    @Body() body: FinalizeConnectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgConnections.finalize(u, body.connectedAccountId);
  }

  @Delete("connections/org/:connectionId")
  @ResponseSchema(integrationsDisconnectResponseSchema)
  @RequirePermission("integrations:connections:manage")
  @Validate({ params: connectionIdParams })
  disconnectOrgConnection(
    @Param("connectionId", ParseIntPipe) connectionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgConnections.disconnect(u, connectionId);
  }

  @Delete("connections/:connectionId")
  @ResponseSchema(integrationsDisconnectResponseSchema)
  @RequirePermission("integrations:connections:manage")
  @Validate({ params: connectionIdParams })
  disconnect(
    @Param("connectionId", ParseIntPipe) connectionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.integrations.disconnect(u.orgId, u.userId, connectionId, actingMembershipId(u.principal));
  }

  @Patch("connections/:connectionId/primary")
  @BodylessAction()
  @ResponseSchema(integrationsSetPrimaryResponseSchema)
  @RequirePermission("integrations:connections:manage")
  @Validate({ params: connectionIdParams })
  setPrimary(
    @Param("connectionId", ParseIntPipe) connectionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.integrations.setPrimary(u.orgId, u.userId, connectionId, actingMembershipId(u.principal));
  }
}
