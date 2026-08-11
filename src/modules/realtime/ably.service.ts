import { Injectable } from "@nestjs/common";
import Ably, { type capabilityOp } from "ably";
import { logger } from "../../common/logger/logger.service";
import type { ChatMessagePayload } from "./dto/realtime.schemas";

const CHAT_TOKEN_TTL_MS = 3_600 * 1_000;
const MAX_CAPABILITY_CHANNELS = 500;

@Injectable()
export class AblyService {
  private readonly apiKey = process.env.ABLY_API_KEY?.trim();
  private restClient: Ably.Rest | null = null;

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  channelName(orgId: string, channelId: number): string {
    return `chat:${orgId}:${channelId}`;
  }

  createChatTokenRequest(
    clientId: string,
    orgId: string,
    channelIds: readonly number[],
  ): Promise<Ably.TokenRequest> {
    if (channelIds.length > MAX_CAPABILITY_CHANNELS) {
      logger.warn("ably: channel capability list truncated", {
        orgId,
        userId: clientId,
        total: channelIds.length,
        granted: MAX_CAPABILITY_CHANNELS,
      });
    }
    const capability: Record<string, capabilityOp[]> = {
      [`notifications:${orgId}:${clientId}`]: ["subscribe"],
      [`huddle-signal:${orgId}:*:${clientId}`]: ["subscribe"],
    };
    for (const channelId of channelIds.slice(0, MAX_CAPABILITY_CHANNELS)) {
      capability[`chat:${orgId}:${channelId}`] = ["subscribe", "publish", "history"];
      capability[`huddle:${orgId}:${channelId}`] = ["subscribe", "publish"];
    }
    return this.rest().auth.createTokenRequest({ clientId, capability, ttl: CHAT_TOKEN_TTL_MS });
  }

  async publishChatMessage(
    orgId: string,
    channelId: number,
    payload: ChatMessagePayload,
  ): Promise<void> {
    if (!this.apiKey) return;
    await this.rest()
      .channels.get(this.channelName(orgId, channelId))
      .publish("message", payload)
      .catch(() => undefined);
  }

  async publishChatEvent(orgId: string, channelId: number, event: string, data: unknown): Promise<void> {
    if (!this.apiKey) return;
    await this.rest()
      .channels.get(this.channelName(orgId, channelId))
      .publish(event, data)
      .catch(() => undefined);
  }

  async publishHuddleEvent(orgId: string, channelId: number, event: string, data: unknown): Promise<void> {
    if (!this.apiKey) return;
    await this.rest()
      .channels.get(`huddle:${orgId}:${channelId}`)
      .publish(event, data)
      .catch(() => undefined);
  }

  async publishHuddleSignal(orgId: string, channelId: number, targetUserId: string, data: unknown): Promise<void> {
    if (!this.apiKey) return;
    await this.rest()
      .channels.get(`huddle-signal:${orgId}:${channelId}:${targetUserId}`)
      .publish("signal", data)
      .catch(() => undefined);
  }

  async publishToUser(orgId: string, userId: string, event: string, data: unknown): Promise<void> {
    if (!this.apiKey) return;
    await this.rest().channels.get(`notifications:${orgId}:${userId}`).publish(event, data).catch(() => undefined);
  }

  supportChannelName(orgId: string, ticketId: number): string {
    return `support:${orgId}:${ticketId}`;
  }

  createSupportTokenRequest(clientId: string, orgId: string): Promise<Ably.TokenRequest> {
    const capability: Ably.TokenParams["capability"] = {
      [`support:${orgId}:*`]: ["subscribe", "presence"],
    };
    return this.rest().auth.createTokenRequest({ clientId, capability, ttl: CHAT_TOKEN_TTL_MS });
  }

  async publishSupportTicketEvent(
    orgId: string,
    ticketId: number,
    event: string,
    data: unknown,
  ): Promise<void> {
    if (!this.apiKey) return;
    await this.rest()
      .channels.get(this.supportChannelName(orgId, ticketId))
      .publish(event, data)
      .catch(() => undefined);
  }

  private rest(): Ably.Rest {
    if (!this.apiKey) {
      throw new Error("Ably is not configured");
    }
    if (!this.restClient) {
      this.restClient = new Ably.Rest(this.apiKey);
    }
    return this.restClient;
  }
}
