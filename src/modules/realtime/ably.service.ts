import { Inject, Injectable, Logger } from "@nestjs/common";
import Ably, { type capabilityOp } from "ably";
import { logger } from "../../common/logger/logger.service";
import type { ChatMessagePayload } from "./dto/realtime.schemas";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import { LEGACY_CELL_ID } from "../../common/region/placement";
import { cellPrefixed } from "../../common/cell-transport/cell-channel-namespace";

const CHAT_TOKEN_TTL_MS = 3_600 * 1_000;
export const MAX_CAPABILITY_CHANNELS = 500;

@Injectable()
export class AblyService {
  private readonly logger = new Logger(AblyService.name);
  private readonly apiKey: string | undefined;
  private readonly cellId: string;
  private restClient: Ably.Rest | null = null;

  constructor(
    @Inject(APP_CONFIG)
    private readonly config: Pick<AppConfig, "ABLY_API_KEY" | "CELL_ID">,
  ) {
    this.apiKey = this.config.ABLY_API_KEY?.trim();
    this.cellId = this.config.CELL_ID?.trim() ?? LEGACY_CELL_ID;
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  channelName(orgId: string, channelId: number): string {
    return cellPrefixed(this.cellId, `chat:${orgId}:${channelId}`);
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
      [cellPrefixed(this.cellId, `notifications:${orgId}:${clientId}`)]: [
        "subscribe",
      ],
      [cellPrefixed(this.cellId, `huddle-signal:${orgId}:*:${clientId}`)]: [
        "subscribe",
      ],
    };
    for (const channelId of channelIds.slice(0, MAX_CAPABILITY_CHANNELS)) {
      capability[cellPrefixed(this.cellId, `chat:${orgId}:${channelId}`)] = [
        "subscribe",
        "publish",
        "history",
      ];
      capability[cellPrefixed(this.cellId, `huddle:${orgId}:${channelId}`)] = [
        "subscribe",
        "publish",
      ];
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
      .catch((error: unknown) => {
        this.logger.error("ably: publishChatEvent failed", {
          orgId,
          channelId,
          event,
          error: error instanceof Error ? error.message : String(error),
          cause:
            error instanceof Error && error.cause instanceof Error
              ? error.cause.message
              : undefined,
        });
      });
  }

  async publishHuddleEvent(
    orgId: string,
    channelId: number,
    event: string,
    data: unknown,
  ): Promise<void> {
    if (!this.apiKey) return;
    await this.rest()
      .channels.get(cellPrefixed(this.cellId, `huddle:${orgId}:${channelId}`))
      .publish(event, data)
      .catch((error: unknown) => {
        this.logger.error("ably: publishHuddleEvent failed", {
          orgId,
          channelId,
          event,
          error: error instanceof Error ? error.message : String(error),
          cause:
            error instanceof Error && error.cause instanceof Error
              ? error.cause.message
              : undefined,
        });
      });
  }

  async publishHuddleSignal(
    orgId: string,
    channelId: number,
    targetUserId: string,
    data: unknown,
  ): Promise<void> {
    if (!this.apiKey) return;
    await this.rest()
      .channels.get(
        cellPrefixed(
          this.cellId,
          `huddle-signal:${orgId}:${channelId}:${targetUserId}`,
        ),
      )
      .publish("signal", data)
      .catch((error: unknown) => {
        this.logger.error("ably: publishHuddleSignal failed", {
          orgId,
          channelId,
          targetUserId,
          error: error instanceof Error ? error.message : String(error),
          cause:
            error instanceof Error && error.cause instanceof Error
              ? error.cause.message
              : undefined,
        });
      });
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
      .channels.get(
        cellPrefixed(this.cellId, `notifications:${orgId}:${userId}`),
      )
      .publish(event, data);
  }

  supportChannelName(orgId: string, ticketId: number): string {
    return cellPrefixed(this.cellId, `support:${orgId}:${ticketId}`);
  }

  createSupportTokenRequest(
    clientId: string,
    orgId: string,
    grant: { wildcard: true } | { wildcard: false; ticketIds: number[] },
  ): Promise<Ably.TokenRequest> {
    const capability: Ably.TokenParams["capability"] = grant.wildcard
      ? {
          [cellPrefixed(this.cellId, `support:${orgId}:*`)]: [
            "subscribe",
            "presence",
          ],
        }
      : Object.fromEntries(
          grant.ticketIds.map((id) => [
            cellPrefixed(this.cellId, `support:${orgId}:${id}`),
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
    await this.rest().auth.revokeTokens([
      { type: "clientId", value: userId },
    ]);
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
      .catch((error: unknown) => {
        this.logger.error("ably: publishSupportTicketEvent failed", {
          orgId,
          ticketId,
          event,
          error: error instanceof Error ? error.message : String(error),
          cause:
            error instanceof Error && error.cause instanceof Error
              ? error.cause.message
              : undefined,
        });
      });
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
