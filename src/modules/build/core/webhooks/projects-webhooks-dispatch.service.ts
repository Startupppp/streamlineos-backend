import { Injectable, Inject } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { projectWebhooks } from "../../../../db/schema/build/tasks";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import {
  WebhookEndpointService,
  type DeliveryIntent,
} from "../../../integrations/core/webhook-endpoint.service";

export interface WebhookPayload extends Record<string, unknown> {
  id: number;
  projectId: number;
  actor: string;
  timestamp: string;
}

@Injectable()
export class ProjectsWebhooksDispatchService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly webhookEndpoint: WebhookEndpointService,
  ) {}

  async dispatch(
    orgId: string,
    projectId: number,
    eventName: string,
    payload: WebhookPayload,
  ): Promise<void> {
    await runInTenantTransaction(
      this.db,
      (tx) => this.enqueue(tx, orgId, projectId, eventName, payload),
      { orgId },
    );
  }

  async enqueue(
    tx: DbOrTx,
    orgId: string,
    projectId: number,
    eventName: string,
    payload: WebhookPayload,
  ): Promise<void> {
    const rows = await tx
      .select({
        id: projectWebhooks.id,
        events: projectWebhooks.events,
        url: projectWebhooks.url,
        integrationsEndpointId: projectWebhooks.integrationsEndpointId,
      })
      .from(projectWebhooks)
      .where(
        and(
          eq(projectWebhooks.orgId, orgId),
          eq(projectWebhooks.projectId, projectId),
          eq(projectWebhooks.isActive, true),
        ),
      );

    const intents: DeliveryIntent[] = [];
    for (const r of rows) {
      if (r.integrationsEndpointId === null) continue;
      if (r.events.length !== 0 && !r.events.includes(eventName) && !r.events.includes("*"))
        continue;
      intents.push({
        credentialId: r.integrationsEndpointId,
        buildWebhookId: r.id,
        targetUrl: r.url,
        event: eventName,
        payload,
      });
    }

    if (intents.length === 0) return;
    await this.webhookEndpoint.requestDeliveries(tx, orgId, intents);
  }

  async sendTest(
    orgId: string,
    projectId: number,
    webhookId: number,
  ): Promise<{ success: boolean; responseCode: number | null }> {
    const endpointRow = await this.db
      .select({
        id: projectWebhooks.id,
        url: projectWebhooks.url,
        integrationsEndpointId: projectWebhooks.integrationsEndpointId,
      })
      .from(projectWebhooks)
      .where(
        and(
          eq(projectWebhooks.id, webhookId),
          eq(projectWebhooks.orgId, orgId),
          eq(projectWebhooks.projectId, projectId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);

    if (!endpointRow) return { success: false, responseCode: null };

    const testPayload: WebhookPayload = {
      id: webhookId,
      projectId,
      actor: "system",
      timestamp: new Date().toISOString(),
      message: "This is a test delivery from StreamlineOS.",
    };

    return this.webhookEndpoint.sendTestDelivery(
      orgId,
      webhookId,
      endpointRow.integrationsEndpointId,
      endpointRow.url,
      testPayload,
    );
  }
}
