import { Injectable } from "@nestjs/common";
import { WebhookEndpointService } from "../integrations/core/webhook-endpoint.service";

const WEBHOOK_DELIVERY_RETENTION_DAYS = 90;

@Injectable()
export class CronBuildRetentionService {
  constructor(private readonly webhookEndpoint: WebhookEndpointService) {}

  async pruneWebhookDeliveries(): Promise<{ webhookDeliveriesPruned: number }> {
    const cutoff = new Date(
      Date.now() - WEBHOOK_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    const webhookDeliveriesPruned = await this.webhookEndpoint.pruneDeliveries(cutoff);

    return { webhookDeliveriesPruned };
  }
}
