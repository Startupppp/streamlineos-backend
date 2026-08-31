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
import { IntegrationsService } from "./integrations.service";
import {
  finalizeConnectionSchema,
  initiateConnectionSchema,
  type FinalizeConnectionInput,
  type InitiateConnectionInput,
} from "./dto/integrations.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const connectionIdParams = z.object({ connectionId: z.coerce.number().int().positive() }).strict();

@Controller("integrations")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get("connections")
  @RequirePermission("integrations:connections:view")
  listConnections(@CurrentUser() u: CurrentUserContext) {
    return this.integrations.listConnections(u.orgId, u.userId);
  }

  @Post("connections/initiate")
  @HttpCode(200)
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
  @RequirePermission("integrations:connections:manage")
  @Validate({ body: finalizeConnectionSchema })
  finalize(
    @Body() body: FinalizeConnectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.integrations.finalize(u.orgId, u.userId, body.connectedAccountId);
  }

  @Delete("connections/:connectionId")
  @RequirePermission("integrations:connections:manage")
  @Validate({ params: connectionIdParams })
  disconnect(
    @Param("connectionId", ParseIntPipe) connectionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.integrations.disconnect(u.orgId, u.userId, connectionId);
  }

  @Patch("connections/:connectionId/primary")
  @BodylessAction()
  @RequirePermission("integrations:connections:manage")
  @Validate({ params: connectionIdParams })
  setPrimary(
    @Param("connectionId", ParseIntPipe) connectionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.integrations.setPrimary(u.orgId, u.userId, connectionId);
  }
}
