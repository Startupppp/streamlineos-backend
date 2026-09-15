import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { AiCreditsService } from "./ai-credits.service";
import { PlatformMerchantService } from "../payments/platform-merchant.service";
import { PLATFORM_PRICE_CURRENCY } from "./plan-entitlements.constants";

@Injectable()
export class BillingMarketplace {
  constructor(
    private readonly aiCredits: AiCreditsService,
    private readonly platformMerchant: PlatformMerchantService,
  ) {}

  getMarketplace() {
    return { apps: [], addons: [] };
  }

  async purchaseAddon(orgId: string, addonId: string, quantity: number) {
    if (!addonId.startsWith("ai_pack_")) {
      throw new BadRequestException("Unknown addon type");
    }

    const packId = parseInt(addonId.replace("ai_pack_", ""), 10);
    const packs = await this.aiCredits.listPacks();
    const pack = packs.find((item) => item.id === packId);
    if (!pack) throw new BadRequestException("AI credit pack not found");

    const merchant = this.platformMerchant.resolve();
    if (!merchant || !merchant.isReady()) {
      throw new ServiceUnavailableException(
        "Payment gateway not configured. Contact support.",
      );
    }

    // `ai_credit_packs.price_in_paise` is a platform table with no org_id: MINOR UNITS of
    // PLATFORM_PRICE_CURRENCY, full stop. This used to be labelled with the buyer's own
    // accounting base currency, which billed a USD-books tenant $499 for a ₹499 pack.
    const currency = PLATFORM_PRICE_CURRENCY;
    const { providerOrderId: addonOrderId } = await merchant.createOrder({
      // paise x quantity — minor units of `currency`
      amount: String(pack.priceInPaise * quantity),
      currency,
      receipt: `aip_${packId}_${orgId.slice(-8)}_${Date.now().toString().slice(-8)}`,
      notes: {
        orgId: String(orgId),
        packId: String(packId),
        quantity: String(quantity),
      },
    });

    return {
      orderId: addonOrderId,
      amount: pack.priceInPaise * quantity,
      currency,
      keyId: merchant.publicKeyId(),
      pack,
    };
  }

  listAddons() {
    return {
      addons: [
        {
          id: "ai_credits",
          name: "AI Credit Packs",
          description: "Purchase additional AI processing credits",
          icon: "Zap",
          available: true,
          href: "/settings/billing/ai-credits",
        },
        {
          id: "extra_storage",
          name: "Extra Storage",
          description: "Add 100GB of document and file storage",
          icon: "HardDrive",
          priceInPaise: 49900,
          available: false,
        },
        {
          id: "whatsapp",
          name: "WhatsApp Messaging",
          description: "1000 WhatsApp messages/month",
          icon: "MessageSquare",
          priceInPaise: 199900,
          available: false,
          comingSoon: true,
        },
        {
          id: "sms_credits",
          name: "SMS Credits",
          description: "Bulk SMS for notifications and alerts",
          icon: "Phone",
          priceInPaise: 99900,
          available: false,
          comingSoon: true,
        },
        {
          id: "voice_ai",
          name: "Voice AI",
          description: "AI-powered voice calling and transcription",
          icon: "Mic",
          priceInPaise: 499900,
          available: false,
          comingSoon: true,
        },
        {
          id: "white_label",
          name: "White Label",
          description: "Remove StreamlineOS branding",
          icon: "Tag",
          priceInPaise: 999900,
          available: false,
          comingSoon: true,
        },
        {
          id: "custom_domain",
          name: "Custom Domain",
          description: "Use your own domain for the platform",
          icon: "Globe",
          priceInPaise: 299900,
          available: false,
          comingSoon: true,
        },
        {
          id: "premium_support",
          name: "Premium Support",
          description: "24/7 dedicated support with SLA guarantees",
          icon: "HeadphonesIcon",
          priceInPaise: 1999900,
          available: false,
          comingSoon: true,
        },
        {
          id: "api_capacity",
          name: "API Capacity",
          description: "Higher API rate limits and throughput",
          icon: "Server",
          priceInPaise: 149900,
          available: false,
          comingSoon: true,
        },
      ],
    };
  }
}
