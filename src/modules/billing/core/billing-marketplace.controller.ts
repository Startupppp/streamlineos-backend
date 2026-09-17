import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { BillingMarketplace } from "./billing-marketplace";
import { MarketplaceService } from "./marketplace.service";
import { AiCreditsService } from "./ai-credits.service";
import { AiCreditsPacksService } from "./ai-credits-packs.service";
import { AiCreditsUsageService } from "./ai-credits-usage.service";
import { PaymentProviderResolver } from "../payments/payment-provider-resolver.service";
import { aiCreditsUsageQuerySchema, autoTopUpSchema, listTransactionsSchema, purchaseAiPackSchema, type PurchaseAiPackInput } from "./dto/ai-credits.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  appListResponseSchema,
  appInstallationResponseSchema,
  aiCreditsWalletResponseSchema,
  aiCreditsTransactionPageSchema,
  aiCreditsUsageResponseSchema,
  autoTopUpResponseSchema,
  purchaseAiCreditsResponseSchema,
} from "./dto/billing-marketplace-response.schemas";

const appIdParams = z.object({ appId: z.coerce.number().int().positive() }).strict();

@Controller("billing")
@UseGuards(JwtAuthGuard)
export class BillingMarketplaceController {
  constructor(
    private readonly billingMarketplace: BillingMarketplace,
    private readonly marketplace: MarketplaceService,
    private readonly aiCredits: AiCreditsService,
    private readonly aiCreditPacks: AiCreditsPacksService,
    private readonly aiCreditsUsage: AiCreditsUsageService,
    private readonly providers: PaymentProviderResolver,
  ) {}

  @Get("marketplace/apps")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:marketplace:view")
  @ResponseSchema(appListResponseSchema)
  listApps(@CurrentUser() u: CurrentUserContext) {
    return this.marketplace.listApps(u.orgId);
  }

  @Post("marketplace/:appId/install")
  @BodylessAction()
  @Idempotent("billing.marketplace.install")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:marketplace:install")
  @Validate({ params: appIdParams })
  @ResponseSchema(appInstallationResponseSchema)
  installApp(
    @Param("appId", ParseIntPipe) appId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.marketplace.installApp(u.orgId, u.userId, appId);
  }

  @Delete("marketplace/:appId/install")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:marketplace:install")
  @Validate({ params: appIdParams })
  @ResponseSchema(appInstallationResponseSchema)
  uninstallApp(
    @Param("appId", ParseIntPipe) appId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.marketplace.uninstallApp(u.orgId, appId);
  }

  @Post("marketplace/:appId/trial")
  @BodylessAction()
  @Idempotent("billing.marketplace.trial")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:marketplace:install")
  @Validate({ params: appIdParams })
  @ResponseSchema(appInstallationResponseSchema)
  startTrial(
    @Param("appId", ParseIntPipe) appId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.marketplace.startAppTrial(u.orgId, u.userId, appId);
  }

  @Get("ai-credits")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:ai-credits:view")
  @ResponseSchema(aiCreditsWalletResponseSchema)
  async getAiCredits(@CurrentUser() u: CurrentUserContext) {
    const [wallet, packs] = await Promise.all([
      this.aiCredits.getWallet(u.orgId),
      this.aiCredits.listPacks(),
    ]);
    return { ...wallet, packs };
  }

  @Get("ai-credits/transactions")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:ai-credits:view")
  @Validate({ query: listTransactionsSchema })
  @ResponseSchema(aiCreditsTransactionPageSchema)
  listAiCreditTransactions(
    @Query() query: ReturnType<typeof listTransactionsSchema.parse>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.aiCreditPacks.listTransactions(u.orgId, query);
  }

  @Get("ai-credits/usage")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:ai-credits:view")
  @Validate({ query: aiCreditsUsageQuerySchema })
  @ResponseSchema(aiCreditsUsageResponseSchema)
  getAiCreditsUsage(
    @Query() query: ReturnType<typeof aiCreditsUsageQuerySchema.parse>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.aiCreditsUsage.getUsage(u.orgId, query.days);
  }

  @Post("ai-credits/auto-topup")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:ai-credits:purchase")
  @Validate({ body: autoTopUpSchema })
  @ResponseSchema(autoTopUpResponseSchema)
  async configureAutoTopUp(
    @Body() body: ReturnType<typeof autoTopUpSchema.parse>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.aiCredits.updateAutoTopUp(
      u.orgId,
      body.enabled,
      body.packId,
      body.threshold,
    );
  }

  @Post("ai-credits/purchase")
  @Idempotent("billing.ai-credits.purchase")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:ai-credits:purchase")
  @Validate({ body: purchaseAiPackSchema })
  @ResponseSchema(purchaseAiCreditsResponseSchema)
  async purchaseAiCredits(
    @Body() body: PurchaseAiPackInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (body.paymentId) {
      const adapter = await this.providers.resolveConfigured(u.orgId);
      const valid =
        adapter?.verifyPaymentSignature({
          orderId: body.orderId ?? "",
          paymentId: body.paymentId,
          signature: body.signature ?? "",
        }) ?? false;
      if (!valid) throw new BadRequestException("Invalid payment signature");
      return this.aiCredits.purchaseCreditsDirectly(u.orgId, u.userId, body.packId, false, body.paymentId);
    }
    if ((await this.providers.resolveConfigured(u.orgId))?.isReady() ?? false)
      return this.billingMarketplace.purchaseAddon(u.orgId, `ai_pack_${body.packId}`, 1);
    return this.aiCredits.purchaseCreditsDirectly(u.orgId, u.userId, body.packId);
  }
}
