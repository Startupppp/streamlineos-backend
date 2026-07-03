import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
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
import { PaymentTestTransactionService } from "./payment-test-transaction.service";
import { PaymentWebhookHealthService } from "./payment-webhook-health.service";
import { PaymentReadinessService } from "./payment-readiness.service";
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
import {
  createTestTransactionSchema,
  verifyTestTransactionSchema,
  type CreateTestTransactionInput,
  type VerifyTestTransactionInput,
} from "./dto/test-transaction.schemas";
import {
  generateWebhookSchema,
  verifyWebhookSchema,
  type GenerateWebhookInput,
  type VerifyWebhookInput,
} from "./dto/webhook.schemas";

@Controller("payments")
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(
    private readonly providers: PaymentProviderSetupService,
    private readonly testTransactions: PaymentTestTransactionService,
    private readonly webhooks: PaymentWebhookHealthService,
    private readonly readiness: PaymentReadinessService,
  ) {}

  private apiBaseUrl(req: Request): string {
    const protocol = req.headers["x-forwarded-proto"] ?? req.protocol ?? "https";
    const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost:1000";
    return `${String(protocol)}://${String(host)}`;
  }

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

  @Get("providers/:providerKey/test-transactions")
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:providers:view")
  listTestTransactions(@Param("providerKey") providerKey: string, @CurrentUser() u: CurrentUserContext) {
    return this.testTransactions.listForProvider(u.orgId, providerKey);
  }

  @Post("providers/:providerKey/test-transactions")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:test:run")
  createTestTransaction(
    @Param("providerKey") providerKey: string,
    @Body(new ZodValidationPipe(createTestTransactionSchema)) body: CreateTestTransactionInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.testTransactions.createTestTransaction(u.orgId, providerKey, body, this.actorContext(u, req));
  }

  @Patch("providers/:providerKey/test-transactions/:id/verify")
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:test:run")
  verifyTestTransaction(
    @Param("providerKey") providerKey: string,
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(verifyTestTransactionSchema)) body: VerifyTestTransactionInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.testTransactions.verifyTestTransaction(u.orgId, providerKey, id, body, this.actorContext(u, req));
  }

  @Post("providers/:providerKey/webhooks/generate")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:webhooks:manage")
  generateWebhook(
    @Param("providerKey") providerKey: string,
    @Body(new ZodValidationPipe(generateWebhookSchema)) body: GenerateWebhookInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.webhooks.generateEndpoint(u.orgId, providerKey, body.environment, this.apiBaseUrl(req), this.actorContext(u, req));
  }

  @Post("providers/:providerKey/webhooks/verify")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:webhooks:manage")
  verifyWebhook(
    @Param("providerKey") providerKey: string,
    @Body(new ZodValidationPipe(verifyWebhookSchema)) body: VerifyWebhookInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    const sample = body.rawBody && body.signature ? { rawBody: body.rawBody, signature: body.signature } : undefined;
    return this.webhooks.verifyEndpointManual(u.orgId, providerKey, body.environment, sample, this.actorContext(u, req));
  }

  @Get("providers/:providerKey/webhooks/events")
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:webhooks:view")
  listWebhookEvents(@Param("providerKey") providerKey: string, @CurrentUser() u: CurrentUserContext) {
    return this.webhooks.listEvents(u.orgId, providerKey);
  }

  @Post("providers/:providerKey/webhooks/events/:eventId/retry")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:webhooks:manage")
  retryWebhookEvent(
    @Param("providerKey") providerKey: string,
    @Param("eventId", ParseIntPipe) eventId: number,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.webhooks.retryEvent(u.orgId, providerKey, eventId, this.actorContext(u, req));
  }

  @Get("providers/:providerKey/readiness")
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:providers:view")
  getReadiness(@Param("providerKey") providerKey: string, @CurrentUser() u: CurrentUserContext) {
    return this.readiness.getReadiness(u.orgId, providerKey);
  }

  @Post("providers/:providerKey/activate-live")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:live:activate")
  activateLive(
    @Param("providerKey") providerKey: string,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.readiness.activateLive(u.orgId, providerKey, this.actorContext(u, req));
  }
}
