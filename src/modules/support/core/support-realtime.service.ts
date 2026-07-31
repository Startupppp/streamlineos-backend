import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { AblyService } from "../../realtime/ably.service";

@Injectable()
export class SupportRealtimeService {
  constructor(private readonly ably: AblyService) {}

  async createTokenRequest(userId: string, orgId: string) {
    if (!this.ably.configured) {
      throw new ServiceUnavailableException("Realtime updates are not configured");
    }
    return this.ably.createSupportTokenRequest(userId, orgId);
  }

  async publishTicketUpdated(orgId: string, ticketId: number, updatedAt: Date): Promise<void> {
    await this.ably.publishSupportTicketEvent(orgId, ticketId, "ticket-updated", {
      ticketId,
      updatedAt: updatedAt.toISOString(),
    });
  }

  async publishMessageCreated(orgId: string, ticketId: number, messageId: number): Promise<void> {
    await this.ably.publishSupportTicketEvent(orgId, ticketId, "message", { ticketId, messageId });
  }
}
