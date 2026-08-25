import { Inject, Injectable, Logger } from "@nestjs/common";
import Ably, { type capabilityOp } from "ably";
import { logger } from "../../common/logger/logger.service";
import type { ChatMessagePayload } from "./dto/realtime.schemas";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";

const CHAT_TOKEN_TTL_MS = 3_600 * 1_000;
const MAX_CAPABILITY_CHANNELS = 500;

@Injectable()
export class AblyService {
  private readonly logger = new Logger(AblyService.name);
  private readonly apiKey: string | undefined;
  private restClient: Ably.Rest | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: Pick<AppConfig, "ABLY_API_KEY">) {
    this.apiKey = this.config.ABLY_API_KEY?.trim();
  }

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
      capability[`chat:${orgId}:${channelId}`] = [
        "subscribe",
        "publish",
        "history",
      ];
      capability[`huddle:${orgId}:${channelId}`] = ["subscribe", "publish"];
    }
    return this.rest().auth.createTokenRequest({
      clientId,
      capability,
      ttl: CHAT_TOKEN_TTL_MS,
    });
  }

  async publishChatMessage(
    orgId: string,
    channelId: number,
    payload: ChatMessagePayload,
    options?: { requireConfigured?: boolean },
  ): Promise<void> {
    if (!this.apiKey) {
      if (options?.requireConfigured) throw new Error("Ably is not configured");
      return;
    }
    await this.rest()
      .channels.get(this.channelName(orgId, channelId))
      .publish("message", payload);
  }

  async publishChatEvent(
    orgId: string,
    channelId: number,
    event: string,
    data: unknown,
  ): Promise<void> {
    if (!this.apiKey) return;
    await this.rest()
      .channels.get(this.channelName(orgId, channelId))
      .publish(event, data)
      .catch(() => undefined);
  }

  async publishHuddleEvent(
    orgId: string,
    channelId: number,
    event: string,
    data: unknown,
  ): Promise<void> {
    if (!this.apiKey) return;
    await this.rest()
      .channels.get(`huddle:${orgId}:${channelId}`)
      .publish(event, data)
      .catch(() => undefined);
  }

  async publishHuddleSignal(
    orgId: string,
    channelId: number,
    targetUserId: string,
    data: unknown,
  ): Promise<void> {
    if (!this.apiKey) return;
    await this.rest()
      .channels.get(`huddle-signal:${orgId}:${channelId}:${targetUserId}`)
      .publish("signal", data)
      .catch(() => undefined);
  }

  async publishToUser(
    orgId: string,
    userId: string,
    event: string,
    data: unknown,
    options?: { requireConfigured?: boolean },
  ): Promise<void> {
    if (!this.apiKey) {
      if (options?.requireConfigured) throw new Error("Ably is not configured");
      return;
    }
    await this.rest()
      .channels.get(`notifications:${orgId}:${userId}`)
      .publish(event, data);
  }

  supportChannelName(orgId: string, ticketId: number): string {
    return `support:${orgId}:${ticketId}`;
  }

  createSupportTokenRequest(
    clientId: string,
    orgId: string,
    grant: { wildcard: true } | { wildcard: false; ticketIds: number[] },
  ): Promise<Ably.TokenRequest> {
    const capability: Ably.TokenParams["capability"] = grant.wildcard
      ? { [`support:${orgId}:*`]: ["subscribe", "presence"] }
      : Object.fromEntries(
          grant.ticketIds.map((id) => [
            `support:${orgId}:${id}`,
            ["subscribe", "presence"],
          ]),
        );
    return this.rest().auth.createTokenRequest({
      clientId,
      capability,
      ttl: CHAT_TOKEN_TTL_MS,
    });
  }

  /**
   * RT-006. Ably tokens are minted with a 1-hour TTL and were never revoked, so a
   * deactivated, suspended or removed member kept a live realtime connection for up
   * to an hour after losing access. Revocation is by `clientId`, which is the user id
   * every token here is minted with.
   *
   * Failure is logged, never thrown: revocation runs after the membership change has
   * already committed, and realtime cleanup must not roll back an access revocation.
   * The 1-hour TTL remains the backstop if this call does not land.
   */
  async revokeUserTokens(userId: string): Promise<void> {
    if (!this.configured) return;
    try {
      await this.rest().auth.revokeTokens([{ type: "clientId", value: userId }]);
    } catch (error: unknown) {
      this.logger.error(
        `Failed to revoke Ably tokens for ${userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
