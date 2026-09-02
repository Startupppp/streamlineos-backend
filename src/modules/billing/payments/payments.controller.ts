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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PaymentProviderSetupService } from "./payment-provider-setup.service";
import { PaymentTestTransactionService } from "./payment-test-transaction.service";
import { PaymentWebhookHealthService } from "./payment-webhook-health.service";
import { PaymentReadinessService } from "./payment-readiness.service";
import { PaymentAuditService } from "./payment-audit.service";
import { PaymentManualMethodsService } from "./payment-manual-methods.service";
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
  createManualMethodSchema,
  updateManualMethodSchema,
  type CreateManualMethodInput,
  type UpdateManualMethodInput,
} from "./dto/manual-methods.schemas";
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
import type { RequestActorContext } from "../../../common/audit/actor-context";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const providerKeyParams = z.object({ providerKey: z.string().min(1) }).strict();
const providerKeytransactionIdParams = z.object({ providerKey: z.string().min(1), transactionId: z.coerce.number().int().positive() }).strict();
const providerKeyeventIdParams = z.object({ providerKey: z.string().min(1), eventId: z.coerce.number().int().positive() }).strict();
const methodIdParams = z.object({ methodId: z.coerce.number().int().positive() }).strict();

@Controller("payments")
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(
    private readonly providers: PaymentProviderSetupService,
    private readonly testTransactions: PaymentTestTransactionService,
    private readonly webhooks: PaymentWebhookHealthService,
    private readonly readiness: PaymentReadinessService,
    private readonly audit: PaymentAuditService,
    private readonly manualMethods: PaymentManualMethodsService,
  ) {}

  private apiBaseUrl(req: Request): string {
    const protocol = req.headers["x-forwarded-proto"] ?? req.protocol ?? "https";
    const host = req.headers["x-forwarded-host"] ?? req.headers.host;
    return host ? `${String(protocol)}://${String(host)}` : (process.env.APP_URL ?? "").replace(/\/$/, "");
  }

  private actorContext(u: CurrentUserContext, req: Request): RequestActorContext {
    return {
      orgId: u.orgId,
      userId: u.userId,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    };
  }

  @Get("providers/catalog")
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:providers:view")
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
  @Validate({ body: createProviderSchema })
  createProvider(
    @Body() body: CreateProviderInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.providers.createProvider(u.orgId, body.providerKey, this.actorContext(u, req));
  }

  @Get("providers/:providerKey")
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:providers:view")
  @Validate({ params: providerKeyParams })
  getProvider(@Param("providerKey") providerKey: string, @CurrentUser() u: CurrentUserContext) {
    return this.providers.getProvider(u.orgId, providerKey);
  }

  @Patch("providers/:providerKey")
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:providers:manage")
  @Validate({ params: providerKeyParams, body: updateProviderSchema })
  updateProvider(
    @Param("providerKey") providerKey: string,
    @Body() body: UpdateProviderInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.providers.updateProvider(u.orgId, providerKey, body, this.actorContext(u, req));
  }

  @Post("providers/:providerKey/disable")
  @BodylessAction()
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:providers:manage")
  @Validate({ params: providerKeyParams })
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
  @Validate({ params: providerKeyParams, body: saveCredentialsSchema })
  saveCredentials(
    @Param("providerKey") providerKey: string,
    @Body() body: SaveCredentialsInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.providers.saveCredentials(u.orgId, providerKey, body, this.actorContext(u, req));
  }

  // Published contract: same behaviour as /credentials, kept until a deprecation window runs.
  @Post("providers/:providerKey/credentials/rotate")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:credentials:manage")
  @Validate({ params: providerKeyParams, body: saveCredentialsSchema })
  rotateCredentials(
    @Param("providerKey") providerKey: string,
    @Body() body: SaveCredentialsInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.providers.saveCredentials(u.orgId, providerKey, body, this.actorContext(u, req));
  }

  @Post("providers/:providerKey/disconnect")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:credentials:manage")
  @Validate({ params: providerKeyParams, body: disconnectCredentialsSchema })
  disconnectCredentials(
    @Param("providerKey") providerKey: string,
    @Body() body: DisconnectCredentialsInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.providers.disconnectCredentials(u.orgId, providerKey, body.environment, this.actorContext(u, req));
  }

  @Get("providers/:providerKey/test-transactions")
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:providers:view")
  @Validate({ params: providerKeyParams })
  listTestTransactions(@Param("providerKey") providerKey: string, @CurrentUser() u: CurrentUserContext) {
    return this.testTransactions.listForProvider(u.orgId, providerKey);
  }

  @Post("providers/:providerKey/test-transactions")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:test:run")
  @Validate({ params: providerKeyParams, body: createTestTransactionSchema })
  createTestTransaction(
    @Param("providerKey") providerKey: string,
    @Body() body: CreateTestTransactionInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.testTransactions.createTestTransaction(u.orgId, providerKey, body, this.actorContext(u, req));
  }

  @Patch("providers/:providerKey/test-transactions/:transactionId/verify")
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:test:run")
  @Validate({ params: providerKeytransactionIdParams, body: verifyTestTransactionSchema })
  verifyTestTransaction(
    @Param("providerKey") providerKey: string,
    @Param("transactionId", ParseIntPipe) transactionId: number,
    @Body() body: VerifyTestTransactionInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.testTransactions.verifyTestTransaction(u.orgId, providerKey, transactionId, body, this.actorContext(u, req));
  }

  @Post("providers/:providerKey/webhooks/generate")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:webhooks:manage")
  @Validate({ params: providerKeyParams, body: generateWebhookSchema })
  generateWebhook(
    @Param("providerKey") providerKey: string,
    @Body() body: GenerateWebhookInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.webhooks.generateEndpoint(u.orgId, providerKey, body.environment, this.apiBaseUrl(req), this.actorContext(u, req));
  }

  @Post("providers/:providerKey/webhooks/verify")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:webhooks:manage")
  @Validate({ params: providerKeyParams, body: verifyWebhookSchema })
  verifyWebhook(
    @Param("providerKey") providerKey: string,
    @Body() body: VerifyWebhookInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    const sample = body.rawBody && body.signature ? { rawBody: body.rawBody, signature: body.signature } : undefined;
    return this.webhooks.verifyEndpointManual(u.orgId, providerKey, body.environment, sample, this.actorContext(u, req));
  }

  @Get("providers/:providerKey/webhooks/events")
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:webhooks:view")
  @Validate({ params: providerKeyParams })
  listWebhookEvents(@Param("providerKey") providerKey: string, @CurrentUser() u: CurrentUserContext) {
    return this.webhooks.listEvents(u.orgId, providerKey);
  }

  @Post("providers/:providerKey/webhooks/events/:eventId/retry")
  @BodylessAction()
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:webhooks:manage")
  @Validate({ params: providerKeyeventIdParams })
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
  @Validate({ params: providerKeyParams })
  getReadiness(@Param("providerKey") providerKey: string, @CurrentUser() u: CurrentUserContext) {
    return this.readiness.getReadiness(u.orgId, providerKey);
  }

  @Post("providers/:providerKey/activate-live")
  @BodylessAction()
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:live:activate")
  @Validate({ params: providerKeyParams })
  activateLive(
    @Param("providerKey") providerKey: string,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.readiness.activateLive(u.orgId, providerKey, this.actorContext(u, req));
  }

  @Get("providers/:providerKey/audit")
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:audit:view")
  @Validate({ params: providerKeyParams })
  async listProviderAudit(@Param("providerKey") providerKey: string, @CurrentUser() u: CurrentUserContext) {
    const provider = await this.providers.getProvider(u.orgId, providerKey);
    return this.audit.listForProvider(u.orgId, provider.id);
  }

  @Get("audit")
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:audit:view")
  listAllAudit(@CurrentUser() u: CurrentUserContext) {
    return this.audit.listForOrg(u.orgId);
  }

  @Get("manual-methods")
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:providers:view")
  listManualMethods(@CurrentUser() u: CurrentUserContext) {
    return this.manualMethods.list(u.orgId);
  }

  @Post("manual-methods")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:manual-methods:manage")
  @Validate({ body: createManualMethodSchema })
  createManualMethod(
    @Body() body: CreateManualMethodInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.manualMethods.create(u.orgId, body, this.actorContext(u, req));
  }

  @Patch("manual-methods/:methodId")
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:manual-methods:manage")
  @Validate({ params: methodIdParams, body: updateManualMethodSchema })
  updateManualMethod(
    @Param("methodId", ParseIntPipe) methodId: number,
    @Body() body: UpdateManualMethodInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.manualMethods.update(u.orgId, methodId, body, this.actorContext(u, req));
  }

  @Post("manual-methods/:methodId/disable")
  @BodylessAction()
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("payments:manual-methods:manage")
  @Validate({ params: methodIdParams })
  disableManualMethod(
    @Param("methodId", ParseIntPipe) methodId: number,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.manualMethods.disable(u.orgId, methodId, this.actorContext(u, req));
  }
}
