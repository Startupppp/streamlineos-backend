import { AblyService } from "src/modules/realtime/ably.service";
import { ChatRealtimeController } from "src/modules/chat/chat-realtime.controller";
import type { ChatChannelsService } from "src/modules/chat/chat-channels.service";
import { SupportRealtimeService } from "src/modules/support/core/support-realtime.service";
import { NotificationEventService } from "src/modules/notifications/notification-event.service";
import type { DataScope } from "src/modules/access/access.types";
import type { Observation } from "../matrix.types";
import { accessFor, actorFor, type Standing } from "../standings";
import { boundValues, standIn, type WorldDb } from "../world-db";

const FAKE_ABLY_KEY = "aaaaaa.bbbbbb:ccccccccccccccccccccccc";
const CELL = "cell-1";

function ably(): AblyService {
  return new AblyService({ ABLY_API_KEY: FAKE_ABLY_KEY, CELL_ID: CELL });
}

function capabilityKeys(token: { capability?: string }): string[] {
  const parsed: unknown = JSON.parse(token.capability ?? "{}");
  return parsed !== null && typeof parsed === "object" ? Object.keys(parsed) : [];
}

interface ChatGrant {
  readonly calls: ReadonlyArray<readonly [string, string]>;
  readonly keys: readonly string[];
  readonly clientId: string | undefined;
}

async function mintChat(standing: Standing, orgId: string, channelIds: readonly number[]): Promise<ChatGrant> {
  const calls: Array<readonly [string, string]> = [];
  const channels = standIn<ChatChannelsService>({
    listMemberChannelIds: async (actor: { orgId: string; userId: string }): Promise<number[]> => {
      calls.push([actor.orgId, actor.userId]);
      return [...channelIds];
    },
  });
  const actor = actorFor(standing, orgId);
  const token = await new ChatRealtimeController(ably(), channels).ablyToken(actor);
  return { calls, keys: capabilityKeys(token), clientId: token.clientId };
}

export async function chatGrantSameTenant(standing: Standing, orgId: string, rivalOrg: string): Promise<Observation> {
  const actor = actorFor(standing, orgId);
  const grant = await mintChat(standing, orgId, [7, 9]);
  return {
    outcome: grant.keys.length > 0 ? "allow" : "403",
    checks: {
      channelListReadWithTokenOrgAndUser:
        grant.calls.length === 1 && grant.calls[0][0] === orgId && grant.calls[0][1] === actor.userId,
      everyKeyNamesCallerOrg: grant.keys.every((key) => key.includes(`:${orgId}:`)),
      noKeyNamesRivalOrg: grant.keys.every((key) => !key.includes(rivalOrg)),
      clientIdIsTokenSubject: grant.clientId === actor.userId,
    },
  };
}

export async function chatGrantCrossTenant(standing: Standing, orgId: string, rivalOrg: string): Promise<Observation> {
  const own = await mintChat(standing, orgId, [7, 9]);
  const rival = await mintChat(standing, rivalOrg, [7, 9]);
  const shared = rival.keys.filter((key) => own.keys.includes(key));
  return {
    outcome: shared.length === 0 ? "404" : "allow",
    checks: { bothGrantsNonEmpty: own.keys.length > 0 && rival.keys.length > 0 },
  };
}

async function mintSupport(
  world: WorldDb,
  standing: Standing,
  orgId: string,
  overrides: Readonly<Record<string, DataScope>>,
): Promise<readonly string[]> {
  const service = new SupportRealtimeService(world.db, ably(), accessFor(world, overrides));
  return capabilityKeys(await service.createTokenRequest(actorFor(standing, orgId)));
}

export async function supportGrant(
  world: WorldDb,
  standing: Standing,
  orgId: string,
  rivalOrg: string,
  overrides: Readonly<Record<string, DataScope>> = {},
): Promise<Observation> {
  const readsBefore = world.reads.length;
  const keys = await mintSupport(world, standing, orgId, overrides);
  const ticketReads = world.reads.slice(readsBefore).filter((read) => read.table === "support_tickets");
  const bound = ticketReads.flatMap((read) => boundValues(read.where));
  const wildcard = keys.length === 1 && keys[0] === `cell:${CELL}:support:${orgId}:*`;
  return {
    outcome: keys.length === 0 ? "403" : "allow",
    checks: {
      everyKeyConfinedToCallerOrg: keys.every((key) => key.startsWith(`cell:${CELL}:support:${orgId}:`)),
      noKeyNamesRivalOrg: keys.every((key) => !key.includes(rivalOrg)),
      wildcardOnlyWithoutRowRead: wildcard ? ticketReads.length === 0 : true,
      rowReadBindsCallerOrgOnly: ticketReads.length === 0 || (bound.includes(orgId) && !bound.includes(rivalOrg)),
    },
  };
}

export async function supportGrantCrossTenant(
  world: WorldDb,
  standing: Standing,
  orgId: string,
  rivalOrg: string,
  overrides: Readonly<Record<string, DataScope>>,
): Promise<Observation> {
  const own = await mintSupport(world, standing, orgId, overrides);
  const rival = await mintSupport(world, standing, rivalOrg, overrides);
  return {
    outcome: rival.some((key) => own.includes(key)) ? "allow" : "404",
    checks: { bothGrantsNonEmpty: own.length > 0 && rival.length > 0 },
  };
}

export function sseTokenMinted(standing: Standing, orgId: string): Observation {
  const actor = actorFor(standing, orgId);
  const events = new NotificationEventService();
  const resolved = events.consumeToken(events.generateToken(actor.userId, orgId));
  return {
    outcome: resolved === null ? "403" : "allow",
    checks: { resolvesToMintedSubject: resolved?.orgId === orgId && resolved?.userId === actor.userId },
  };
}

export function sseTokenCrossTenant(standing: Standing, orgId: string, rivalOrg: string): Observation {
  const events = new NotificationEventService();
  const own = events.generateToken(actorFor(standing, orgId).userId, orgId);
  const rival = events.generateToken(actorFor(standing, rivalOrg).userId, rivalOrg);
  const ownResolved = events.consumeToken(own);
  const rivalResolved = events.consumeToken(rival);
  return {
    outcome: ownResolved?.orgId === rivalOrg || rivalResolved?.orgId === orgId ? "allow" : "404",
    checks: { eachTokenResolvesToItsOwnOrg: ownResolved?.orgId === orgId && rivalResolved?.orgId === rivalOrg },
  };
}

export function sseTokenReplayed(standing: Standing, orgId: string): Observation {
  const events = new NotificationEventService();
  const token = events.generateToken(actorFor(standing, orgId).userId, orgId);
  const first = events.consumeToken(token);
  const replay = events.consumeToken(token);
  return { outcome: replay === null ? "403" : "allow", checks: { firstUseResolved: first !== null } };
}

export function sseTokenUnknown(): Observation {
  return { outcome: new NotificationEventService().consumeToken("not-a-token") === null ? "403" : "allow" };
}
