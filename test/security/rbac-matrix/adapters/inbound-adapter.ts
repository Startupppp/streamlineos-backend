import { RateLimitService } from "src/common/ratelimit/rate-limit.service";
import { SupportChannelsController } from "src/modules/support/core/support-channels.controller";
import { SupportChannelsService } from "src/modules/support/core/support-channels.service";
import { AblyService } from "src/modules/realtime/ably.service";
import { ChatRealtimeController } from "src/modules/chat/chat-realtime.controller";
import { ChatChannelsService } from "src/modules/chat/chat-channels.service";
import { ChatChannelListService } from "src/modules/chat/chat-channel-list.service";
import type { Observation } from "../matrix.types";
import type { Standing } from "../standings";
import { ORG_A } from "../standings";
import { standIn, type WorldDb } from "../world-db";
import { sendHttp, type HttpExchange } from "./http-adapter";
import { capabilityAdmits, capabilityOf } from "./realtime-adapter";
import { rateLimitChecks, rateLimiter } from "./sign-token-adapter";

const ingested: Array<{ readonly method: string; readonly orgId: unknown }> = [];

function inboundService(world: WorldDb): SupportChannelsService {
  const service = new SupportChannelsService(world.db, standIn({}));
  for (const method of ["ingestInboundEmail", "ingestInboundWhatsApp", "ingestInboundSms", "startChatSession"])
    Reflect.set(service, method, async (orgId: string) => {
      ingested.push({ method, orgId });
      return { ticketId: 1, sessionToken: "t" };
    });
  return service;
}

export interface InboundAttempt {
  readonly outcome: Observation["outcome"];
  readonly status: number;
  readonly body: unknown;
  readonly checks: ReadonlyArray<readonly [string, string]>;
  readonly ingested: ReadonlyArray<{ readonly method: string; readonly orgId: unknown }>;
}

function refusalOf(exchange: HttpExchange): Observation["outcome"] {
  return exchange.status === 401 ? "403" : exchange.outcome;
}

export const INBOUND_ENTRY = "@Public POST /support/inbound/:channel/:orgId -> SupportChannelsService.verifyInboundSecret (401 Unauthorized recorded as the refusal outcome 403; ingestion recorded)";

export async function inbound(
  world: WorldDb,
  channel: "email" | "whatsapp" | "sms",
  orgId: string,
  secret: string,
  body: object,
): Promise<InboundAttempt> {
  rateLimitChecks.length = 0;
  ingested.length = 0;
  const exchange = await sendHttp(world, {
    controllers: [SupportChannelsController],
    services: [
      { provide: SupportChannelsService, useValue: inboundService(world) },
      { provide: RateLimitService, useValue: rateLimiter },
    ],
    verb: "post",
    path: `/support/inbound/${channel}/${orgId}`,
    body,
    headers: { "x-webhook-secret": secret, "x-forwarded-for": "203.0.113.9" },
    standing: "outsider",
    orgId: ORG_A,
  });
  return { outcome: refusalOf(exchange), status: exchange.status, body: exchange.body, checks: [...rateLimitChecks], ingested: [...ingested] };
}

export async function startChat(world: WorldDb, orgId: string): Promise<InboundAttempt> {
  rateLimitChecks.length = 0;
  ingested.length = 0;
  const exchange = await sendHttp(world, {
    controllers: [SupportChannelsController],
    services: [
      { provide: SupportChannelsService, useValue: inboundService(world) },
      { provide: RateLimitService, useValue: rateLimiter },
    ],
    verb: "post",
    path: `/support/chat/${orgId}/start`,
    body: { name: "Visitor", email: "visitor@example.com", message: "hi" },
    headers: { "x-forwarded-for": "203.0.113.9" },
    standing: "outsider",
    orgId: ORG_A,
  });
  return { outcome: refusalOf(exchange), status: exchange.status, body: exchange.body, checks: [...rateLimitChecks], ingested: [...ingested] };
}

const CELL = "cell-1";

function ably(cell: string): AblyService {
  return new AblyService({ ABLY_API_KEY: "aaaaaa.bbbbbb:ccccccccccccccccccccccc", CELL_ID: cell });
}

export async function chatCapability(world: WorldDb, standing: Standing, orgId: string): Promise<{ outcome: Observation["outcome"]; admits: (orgId: string, channelId: number, cell?: string) => boolean }> {
  const list = new ChatChannelListService(world.db, standIn({}));
  const exchange = await sendHttp(world, {
    controllers: [ChatRealtimeController],
    services: [
      { provide: AblyService, useValue: ably(CELL) },
      { provide: ChatChannelsService, useValue: new ChatChannelsService(world.db, standIn({}), standIn({}), list) },
    ],
    verb: "get",
    path: "/chat/ably-token",
    permissionKey: "chat:messages:read",
    standing,
    orgId,
  });
  const capability = capabilityOf(exchange.body);
  return {
    outcome: exchange.outcome,
    admits: (channelOrg, channelId, cell = CELL) => capabilityAdmits(capability, ably(cell).channelName(channelOrg, channelId)),
  };
}

export function channelNameOf(orgId: string, channelId: number, cell = CELL): string {
  return ably(cell).channelName(orgId, channelId);
}
