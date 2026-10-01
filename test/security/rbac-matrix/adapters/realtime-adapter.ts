import { isObservable } from "rxjs";
import { AblyService } from "src/modules/realtime/ably.service";
import { ChatRealtimeController } from "src/modules/chat/chat-realtime.controller";
import { ChatChannelsService } from "src/modules/chat/chat-channels.service";
import { ChatChannelListService } from "src/modules/chat/chat-channel-list.service";
import { SupportRealtimeController } from "src/modules/support/core/support-realtime.controller";
import { SupportRealtimeService } from "src/modules/support/core/support-realtime.service";
import { NotificationsController } from "src/modules/notifications/notifications.controller";
import { NotificationEventService } from "src/modules/notifications/notification-event.service";
import type { DataScope } from "src/modules/access/access.types";
import type { Observation } from "../matrix.types";
import { accessFor, actorFor, type Standing } from "../standings";
import { boundValues, standIn, type WorldDb } from "../world-db";
import { harnessOf, sendHttp } from "./http-adapter";

const FAKE_ABLY_KEY = "aaaaaa.bbbbbb:ccccccccccccccccccccccc";
const CELL = "cell-1";

function ably(): AblyService {
  return new AblyService({ ABLY_API_KEY: FAKE_ABLY_KEY, CELL_ID: CELL });
}

export function capabilityOf(body: unknown): Readonly<Record<string, unknown>> {
  if (body === null || typeof body !== "object" || !("capability" in body) || typeof body.capability !== "string") return {};
  const parsed: unknown = JSON.parse(body.capability);
  return parsed !== null && typeof parsed === "object" ? Object.fromEntries(Object.entries(parsed)) : {};
}

function clientIdOf(body: unknown): unknown {
  return body !== null && typeof body === "object" && "clientId" in body ? body.clientId : undefined;
}

export function capabilityAdmits(capability: Readonly<Record<string, unknown>>, channel: string): boolean {
  return Object.keys(capability).some((resource) => {
    if (resource === "*" || resource === channel) return true;
    return resource.endsWith("*") && channel.startsWith(resource.slice(0, -1));
  });
}

function chatProviders(world: WorldDb) {
  const list = new ChatChannelListService(world.db, standIn({}));
  return [
    { provide: AblyService, useValue: ably() },
    { provide: ChatChannelsService, useValue: new ChatChannelsService(world.db, standIn({}), standIn({}), list) },
  ];
}

export async function chatToken(
  world: WorldDb,
  standing: Standing,
  orgId: string,
  ownChannels: readonly number[],
  rival: { readonly orgId: string; readonly channels: readonly number[] },
): Promise<Observation> {
  const exchange = await sendHttp(world, {
    controllers: [ChatRealtimeController],
    services: chatProviders(world),
    verb: "get",
    path: "/chat/ably-token",
    permissionKey: "chat:messages:read",
    standing,
    orgId,
  });
  const capability = capabilityOf(exchange.body);
  const naming = ably();
  const ownGranted = ownChannels.every((id) => capabilityAdmits(capability, naming.channelName(orgId, id)));
  const rivalGranted = rival.channels.some((id) => capabilityAdmits(capability, naming.channelName(rival.orgId, id)));
  const reachesRival = exchange.outcome === "allow" && rivalGranted;
  return {
    outcome: reachesRival ? "allow" : exchange.outcome,
    checks: {
      routeAskedForItsKey: exchange.asked.includes("chat:messages:read"),
      tokenSubjectIsCaller: exchange.outcome !== "allow" || clientIdOf(exchange.body) === actorFor(standing, orgId).userId,
      everyMemberChannelSubscribable: exchange.outcome !== "allow" || ownGranted,
      noRivalChannelSubscribable: !rivalGranted,
    },
  };
}

export async function chatTokenAcrossTenants(
  world: WorldDb,
  standing: Standing,
  orgId: string,
  rival: { readonly orgId: string; readonly channels: readonly number[] },
): Promise<Observation> {
  const exchange = await sendHttp(world, {
    controllers: [ChatRealtimeController],
    services: chatProviders(world),
    verb: "get",
    path: "/chat/ably-token",
    permissionKey: "chat:messages:read",
    standing,
    orgId,
  });
  const capability = capabilityOf(exchange.body);
  const naming = ably();
  const rivalGranted = rival.channels.some((id) => capabilityAdmits(capability, naming.channelName(rival.orgId, id)));
  return {
    outcome: exchange.outcome !== "allow" ? exchange.outcome : rivalGranted ? "allow" : "404",
    checks: { tokenWasMinted: exchange.outcome === "allow" && Object.keys(capability).length > 0 },
  };
}

export async function supportToken(
  world: WorldDb,
  standing: Standing,
  orgId: string,
  rival: { readonly orgId: string; readonly tickets: readonly number[] },
  ownTickets: readonly number[],
  overrides: Readonly<Record<string, DataScope>> = {},
): Promise<Observation> {
  const exchange = await sendHttp(world, {
    controllers: [SupportRealtimeController],
    services: [{ provide: SupportRealtimeService, useValue: new SupportRealtimeService(world.db, ably(), accessFor(world, overrides)) }],
    verb: "get",
    path: "/support/ably-token",
    permissionKey: "support:tickets:view",
    standing,
    orgId,
    scopeOverrides: overrides,
    wiring: JSON.stringify(overrides),
  });
  const capability = capabilityOf(exchange.body);
  const naming = ably();
  const ticketReads = world.reads.slice(exchange.readMark).filter((read) => read.table === "support_tickets");
  const bound = ticketReads.flatMap((read) => boundValues(read.where));
  const rivalGranted = rival.tickets.some((id) => capabilityAdmits(capability, naming.supportChannelName(rival.orgId, id)));
  const ownGranted = ownTickets.filter((id) => capabilityAdmits(capability, naming.supportChannelName(orgId, id)));
  const granted = exchange.outcome === "allow" && Object.keys(capability).length > 0;
  return {
    outcome: rivalGranted ? "allow" : granted ? "allow" : exchange.outcome === "allow" ? "403" : exchange.outcome,
    checks: {
      noRivalTicketSubscribable: !rivalGranted,
      ownTicketsSubscribableWhenGranted: !granted || ownGranted.length > 0,
      rowReadBindsCallerOrgOnly: ticketReads.length === 0 || (bound.includes(orgId) && !bound.includes(rival.orgId)),
    },
  };
}

function sseProviders() {
  return [{ provide: NotificationEventService, useValue: new NotificationEventService() }];
}

export interface StreamAttempts {
  readonly minted: Observation["outcome"];
  readonly opened: ReadonlyArray<{ readonly userId: string; readonly orgId: string } | null>;
}

export async function streamAttempts(
  world: WorldDb,
  minter: { readonly standing: Standing; readonly orgId: string },
  presentations: (token: string) => readonly string[],
): Promise<StreamAttempts> {
  const probe = { controllers: [NotificationsController], services: sseProviders() };
  const exchange = await sendHttp(world, {
    ...probe,
    verb: "post",
    path: "/notifications/events/token",
    standing: minter.standing,
    orgId: minter.orgId,
  });
  const body = exchange.body;
  const token = body !== null && typeof body === "object" && "token" in body && typeof body.token === "string" ? body.token : "";
  const harness = await harnessOf(probe);
  const controller = harness.app.get(NotificationsController);
  const events = harness.app.get(NotificationEventService);
  const spy = jest.spyOn(events, "stream");
  try {
    const opened = presentations(token).map((presented) => {
      spy.mockClear();
      try {
        const result = controller.stream(`Bearer ${presented}`);
        const call = spy.mock.calls[0];
        return isObservable(result) && call !== undefined ? { userId: call[0], orgId: call[1] } : null;
      } catch {
        return null;
      }
    });
    return { minted: exchange.outcome, opened };
  } finally {
    spy.mockRestore();
  }
}
