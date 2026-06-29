import { Injectable } from "@nestjs/common";
import Ably from "ably";
import type { ChatMessagePayload } from "./dto/realtime.schemas";

const CHAT_TOKEN_TTL_MS = 3_600 * 1_000;

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

  createChatTokenRequest(clientId: string, orgId: string): Promise<Ably.TokenRequest> {
    const capability: Ably.TokenParams["capability"] = {
      [`chat:${orgId}:*`]: ["subscribe", "publish", "history"],
      [`huddle:${orgId}:*`]: ["subscribe", "publish"],
      [`huddle-signal:${orgId}:*`]: ["subscribe", "publish"],
      [`meeting:${orgId}:*`]: ["subscribe", "publish"],
      [`meeting-signal:${orgId}:*`]: ["subscribe", "publish"],
      [`notifications:${orgId}:${clientId}`]: ["subscribe"],
    };
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

  async publishMeetingEvent(orgId: string, channelId: number, event: string, data: unknown): Promise<void> {
    if (!this.apiKey) return;
    await this.rest().channels.get(`meeting:${orgId}:${channelId}`).publish(event, data).catch(() => undefined);
  }

  async publishMeetingSignal(orgId: string, channelId: number, targetUserId: string, data: unknown): Promise<void> {
    if (!this.apiKey) return;
    await this.rest().channels.get(`meeting-signal:${orgId}:${channelId}:${targetUserId}`).publish("signal", data).catch(() => undefined);
  }

  async publishToUser(orgId: string, userId: string, event: string, data: unknown): Promise<void> {
    if (!this.apiKey) return;
    await this.rest().channels.get(`notifications:${orgId}:${userId}`).publish(event, data).catch(() => undefined);
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
