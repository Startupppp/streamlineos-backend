import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PaymentProviderSetupService, type ActorContext } from "./payment-provider-setup.service";
import {
  createProviderSchema,
  disconnectCredentialsSchema,
  saveCredentialsSchema,
  updateProviderSchema,
  type CreateProviderInput,
  type DisconnectCredentialsInput,
  type SaveCredentialsInput,
  type UpdateProviderInput,
} from "./dto/payments.schemas";

@Controller("payments")
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(private readonly providers: PaymentProviderSetupService) {}

  private actorContext(u: CurrentUserContext, req: Request): ActorContext {
    return {
      orgId: u.orgId,
      userId: u.userId,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    };
  }

  @Get("providers/catalog")
  getCatalog() {
    return this.providers.getCatalog();
  }

  @Get("providers")
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:providers:view")
  listProviders(@CurrentUser() u: CurrentUserContext) {
    return this.providers.listProviders(u.orgId);
  }

  @Post("providers")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:providers:manage")
  createProvider(
    @Body(new ZodValidationPipe(createProviderSchema)) body: CreateProviderInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.providers.createProvider(u.orgId, body.providerKey, this.actorContext(u, req));
  }

  @Get("providers/:providerKey")
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:providers:view")
  getProvider(@Param("providerKey") providerKey: string, @CurrentUser() u: CurrentUserContext) {
    return this.providers.getProvider(u.orgId, providerKey);
  }

  @Patch("providers/:providerKey")
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:providers:manage")
  updateProvider(
    @Param("providerKey") providerKey: string,
    @Body(new ZodValidationPipe(updateProviderSchema)) body: UpdateProviderInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.providers.updateProvider(u.orgId, providerKey, body, this.actorContext(u, req));
  }

  @Post("providers/:providerKey/disable")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:providers:manage")
  disableProvider(
    @Param("providerKey") providerKey: string,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.providers.disableProvider(u.orgId, providerKey, this.actorContext(u, req));
  }

  @Post("providers/:providerKey/credentials")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:credentials:manage")
  saveCredentials(
    @Param("providerKey") providerKey: string,
    @Body(new ZodValidationPipe(saveCredentialsSchema)) body: SaveCredentialsInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.providers.saveCredentials(u.orgId, providerKey, body, this.actorContext(u, req));
  }

  @Post("providers/:providerKey/credentials/rotate")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:credentials:manage")
  rotateCredentials(
    @Param("providerKey") providerKey: string,
    @Body(new ZodValidationPipe(saveCredentialsSchema)) body: SaveCredentialsInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.providers.saveCredentials(u.orgId, providerKey, body, this.actorContext(u, req));
  }

  @Post("providers/:providerKey/disconnect")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:credentials:manage")
  disconnectCredentials(
    @Param("providerKey") providerKey: string,
    @Body(new ZodValidationPipe(disconnectCredentialsSchema)) body: DisconnectCredentialsInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.providers.disconnectCredentials(u.orgId, providerKey, body.environment, this.actorContext(u, req));
  }
}
