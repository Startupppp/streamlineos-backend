/**
 * Realtime adapter for the RBAC verification matrix.
 *
 * The realtime authorization path in this codebase is the Ably token issuance
 * endpoint: `GET /chat/ably-token`.  The token carries a capability document
 * that determines which channels the bearer may subscribe to or publish on.
 *
 * Two security properties are verified here:
 *
 *  1. PERMISSION GATE — a caller missing `chat:messages:read` receives 403;
 *     a caller holding it passes the guard (positive control shows a non-403
 *     response even if AblyService is not configured).
 *
 *  2. TENANT ISOLATION — the capability document built by AblyService scopes
 *     channel names to the caller's own orgId.  Two actors from different orgs
 *     with the same channel ids must receive disjoint capability documents.
 */

import { AblyService } from "src/modules/realtime/ably.service";
import { ChatRealtimeController } from "src/modules/chat/chat-realtime.controller";
import { ORG_A, ORG_B, actorOf } from "../../../helpers/authz-deny-harness";
import { runHttpPermissionCell } from "./http-adapter";

const FAKE_ABLY_KEY = "aaaaaa.bbbbbb:ccccccccccccccccccccccc";

function fakeAbly(): AblyService {
  return new AblyService({ ABLY_API_KEY: FAKE_ABLY_KEY, CELL_ID: "cell-test" });
}

export interface RealtimePermissionResult {
  readonly denyStatus: number;
  readonly allowStatus: number;
}

/**
 * Verifies the HTTP guard on the Ably token endpoint.
 *
 * Deny: actor holds every permission except `chat:messages:read` → 403.
 * Allow: actor holds all permissions → guard passes (allow-status is not 403).
 * The service itself may return 503 when unconfigured — that is a service issue
 * not a guard refusal, so the test only checks that allowStatus !== 403.
 */
export async function runRealtimePermissionCell(): Promise<RealtimePermissionResult> {
  return runHttpPermissionCell({
    controllers: [ChatRealtimeController],
    verb: "get",
    path: "/chat/ably-token",
    permissionKey: "chat:messages:read",
  });
}

export interface RealtimeTenantIsolationResult {
  readonly orgAChannels: readonly string[];
  readonly orgBChannels: readonly string[];
  readonly sharesChannels: boolean;
}

/**
 * Verifies that the Ably token minting scopes channel names to orgId.
 *
 * Both actors request tokens for the same channel ids.  The channel names in
 * the capability document must be namespaced by orgId, so the two sets must be
 * disjoint.  A shared channel name would mean an actor could subscribe to
 * another tenant's messages by reusing a capability they legitimately hold.
 */
export async function runRealtimeTenantIsolationCell(): Promise<RealtimeTenantIsolationResult> {
  const ably = fakeAbly();
  const CHANNEL_IDS = [10, 20] as const;

  const actorA = actorOf({ orgId: ORG_A, userId: "user-a" });
  const actorB = actorOf({ orgId: ORG_B, userId: "user-b" });

  const tokenA = await ably.createChatTokenRequest(actorA.userId, actorA.orgId, [...CHANNEL_IDS]);
  const tokenB = await ably.createChatTokenRequest(actorB.userId, actorB.orgId, [...CHANNEL_IDS]);

  const capA = JSON.parse(tokenA.capability ?? "{}") as Record<string, string[]>;
  const capB = JSON.parse(tokenB.capability ?? "{}") as Record<string, string[]>;

  const orgAChannels = Object.keys(capA);
  const orgBChannels = Object.keys(capB);
  const shared = orgAChannels.filter((k) => orgBChannels.includes(k));

  return {
    orgAChannels,
    orgBChannels,
    sharesChannels: shared.length > 0,
  };
}
