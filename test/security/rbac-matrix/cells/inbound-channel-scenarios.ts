import type { Table } from "drizzle-orm";
import { supportChannels } from "src/db/schema";
import { hashInboundSecret } from "src/modules/support/core/support-inbound-secret";
import type { Observation, Scenario } from "../matrix.types";
import { INBOUND_ENTRY, chatCapability, channelNameOf, inbound, startChat, type InboundAttempt } from "../adapters/inbound-adapter";
import { ORG_A, ORG_B } from "../standings";
import type { Row, WorldDb } from "../world-db";

const EMAIL_SECRET = "inbound-email-secret-0123456789abcdef";
const SMS_SECRET = "inbound-sms-secret-0123456789abcdef";
const LEGACY_SECRET = "legacy-plaintext-secret";
const EMAIL = { messageId: "m-1", fromEmail: "customer@example.com", bodyText: "hello" };
const WHATSAPP = { messageId: "m-2", from: "+15550001", bodyText: "hello" };
const SMS = { messageId: "m-3", from: "+15550001", bodyText: "hello" };

export function inboundRows(): Map<Table, Row[]> {
  const channel = (id: number, orgId: string, type: string, inboundSecret: string): Row => ({ id, orgId, type, name: type, config: {}, isActive: true, inboundSecret });
  return new Map<Table, Row[]>([
    [
      supportChannels,
      [
        channel(4701, ORG_A, "email", hashInboundSecret(EMAIL_SECRET)),
        channel(4702, ORG_A, "whatsapp", LEGACY_SECRET),
        channel(4703, ORG_A, "sms", hashInboundSecret(SMS_SECRET)),
      ],
    ],
  ]);
}

function keyedOnCaller(attempt: InboundAttempt, orgId: string): boolean {
  const first = attempt.checks[0];
  return first !== undefined && first[1] !== orgId;
}

function observe(attempt: InboundAttempt, orgId: string): Observation {
  const proved = attempt.outcome === "allow";
  return {
    outcome: attempt.outcome,
    checks: {
      preAuthLimitKeyedOnTheCallersAddress: keyedOnCaller(attempt, orgId),
      orgQuotaChargedOnlyAfterTheSecretIsProved: proved ? attempt.checks.length === 2 && attempt.checks[1]?.[1] === orgId : attempt.checks.every(([, identifier]) => identifier !== orgId),
      refusalIsUnauthorized: proved || attempt.status === 401,
      ingestsOnlyWhenProved: proved === (attempt.ingested.length === 1),
    },
  };
}

function scenario(id: string, expected: "allow" | "403", because: string, run: () => Promise<Observation>, pairedWith?: string): Scenario {
  return {
    id,
    actor: "tenant-only",
    resource: "support:inbound-webhook",
    action: "ingest",
    tenant: "same",
    state: "normal",
    expected,
    because,
    pairedWith,
    bindings: [{ adapter: "http", entry: INBOUND_ENTRY, run }],
  };
}

function inboundScenarios(world: WorldDb): Scenario[] {
  const allowed = "support-inbound-email-right-secret";
  const wrong = `${EMAIL_SECRET.slice(0, -1)}${EMAIL_SECRET.endsWith("a") ? "b" : "a"}`;
  return [
    scenario(allowed, "allow", "the right secret verifies against its stored digest, and only then is the per-org quota charged", async () => observe(await inbound(world, "email", ORG_A, EMAIL_SECRET, EMAIL), ORG_A)),
    scenario("support-inbound-email-wrong-secret-flood", "403", "five same-length wrong secrets are refused and consume none of the named organisation's quota", async () => {
      const attempts: InboundAttempt[] = [];
      for (let index = 0; index < 5; index += 1) attempts.push(await inbound(world, "email", ORG_A, wrong, EMAIL));
      const last = attempts[attempts.length - 1];
      const observed = observe(last, ORG_A);
      return {
        outcome: attempts.every((attempt) => attempt.outcome === "403") ? "403" : "allow",
        checks: { ...observed.checks, noAttemptChargedTheVictimOrg: attempts.every((attempt) => attempt.checks.every(([, identifier]) => identifier !== ORG_A)) },
      };
    }, allowed),
    scenario("support-inbound-email-unknown-org", "403", "an organisation with no channel fails exactly as a wrong secret does", async () => {
      const unknown = await inbound(world, "email", ORG_B, EMAIL_SECRET, EMAIL);
      const wrongSecret = await inbound(world, "email", ORG_A, wrong, EMAIL);
      const observed = observe(unknown, ORG_B);
      return { outcome: unknown.outcome, checks: { ...observed.checks, sameFailureAsAWrongSecret: JSON.stringify(unknown.body) === JSON.stringify(wrongSecret.body) && unknown.status === wrongSecret.status } };
    }, allowed),
    scenario("support-inbound-whatsapp-legacy-plaintext", "allow", "a row still holding a plaintext secret verifies", async () => observe(await inbound(world, "whatsapp", ORG_A, LEGACY_SECRET, WHATSAPP), ORG_A)),
    scenario("support-inbound-whatsapp-legacy-wrong", "403", "a legacy plaintext row refuses a near-miss secret", async () => observe(await inbound(world, "whatsapp", ORG_A, LEGACY_SECRET.slice(0, -1), WHATSAPP), ORG_A), "support-inbound-whatsapp-legacy-plaintext"),
    scenario("support-inbound-sms-right-secret", "allow", "the sms channel verifies its own digest", async () => observe(await inbound(world, "sms", ORG_A, SMS_SECRET, SMS), ORG_A)),
    scenario("support-inbound-sms-wrong-secret", "403", "the sms channel keys its pre-auth limit on the caller's address and refuses a wrong secret", async () => observe(await inbound(world, "sms", ORG_A, "x", SMS), ORG_A), "support-inbound-sms-right-secret"),
    {
      id: "support-chat-widget-start",
      actor: "tenant-only",
      resource: "support:chat-widget",
      action: "start",
      tenant: "same",
      state: "normal",
      expected: "allow",
      because: "the visitor chat widget start is rate limited on the caller's address, not the named organisation",
      bindings: [
        {
          adapter: "http",
          entry: "@Public POST /support/chat/:orgId/start (session creation recorded)",
          run: async () => {
            const attempt = await startChat(world, ORG_A);
            return { outcome: attempt.outcome, checks: { keyedOnTheCallersAddress: attempt.checks.length === 1 && attempt.checks[0]?.[0] === "support:chat-widget" && attempt.checks[0]?.[1] !== ORG_A } };
          },
        },
      ],
    },
  ];
}

function channelScenarios(world: WorldDb): Scenario[] {
  const entry = "GET /chat/ably-token -> Ably capability matched against cell-prefixed channel names";
  return [
    {
      id: "chat-channel-name-own",
      actor: "org:member",
      resource: "chat:channel",
      action: "subscribe",
      tenant: "same",
      state: "normal",
      expected: "allow",
      because: "channel names embed the cell and the org, so the member's capability admits its own channel and nothing that merely shares its id",
      bindings: [
        {
          adapter: "realtime",
          entry,
          run: async () => {
            const minted = await chatCapability(world, "org:member", ORG_A);
            const own = channelNameOf(ORG_A, 7);
            return {
              outcome: minted.outcome === "allow" && minted.admits(ORG_A, 7) ? "allow" : "403",
              checks: {
                nameEmbedsTheCallersOrgOnly: own.includes(ORG_A) && !own.includes(ORG_B),
                distinctIdsHaveDistinctNames: channelNameOf(ORG_A, 1) !== channelNameOf(ORG_A, 2),
                nameCarriesTheCell: own.includes("cell-1") && channelNameOf(ORG_A, 7, "cell-2").includes("cell-2"),
                anotherCellsChannelIsNotAdmitted: !minted.admits(ORG_A, 7, "cell-2"),
              },
            };
          },
        },
      ],
    },
    {
      id: "chat-channel-name-same-id-other-org",
      actor: "org:member",
      resource: "chat:channel",
      action: "subscribe",
      tenant: "other",
      state: "normal",
      expected: "404",
      because: "another organisation's channel carrying the same id has a different name the capability does not admit",
      pairedWith: "chat-channel-name-own",
      bindings: [
        {
          adapter: "realtime",
          entry,
          run: async () => {
            const minted = await chatCapability(world, "org:member", ORG_A);
            return {
              outcome: minted.admits(ORG_B, 7) ? "allow" : "404",
              checks: { tokenWasMinted: minted.outcome === "allow", namesDiffer: channelNameOf(ORG_A, 7) !== channelNameOf(ORG_B, 7) },
            };
          },
        },
      ],
    },
  ];
}

export function inboundChannelScenarios(world: WorldDb): Scenario[] {
  return [...inboundScenarios(world), ...channelScenarios(world)];
}
