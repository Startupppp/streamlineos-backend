import type { Observation, Scenario } from "../matrix.types";
import { chatToken, chatTokenAcrossTenants, streamAttempts, supportToken } from "../adapters/realtime-adapter";
import { releaseNotificationJob } from "../adapters/job-adapter";
import { recruiterRemoval } from "../adapters/service-adapter";
import { ORG_A, ORG_B, actorFor, userOf, type Standing } from "../standings";
import type { WorldDb } from "../world-db";
import { CHAT_CHANNELS, JOB_A, RECRUITER_A, RELEASE_A, SUPPORT_TICKETS } from "../fixtures";

const NARROWED = { "support:tickets:view": "own" } satisfies Record<string, "own">;
const RIVAL_CHAT = { orgId: ORG_B, channels: CHAT_CHANNELS[ORG_B] ?? [] };
const RIVAL_SUPPORT = { orgId: ORG_B, tickets: SUPPORT_TICKETS[ORG_B] ?? [] };

function chatScenarios(world: WorldDb): Scenario[] {
  const entry = "GET /chat/ably-token -> Ably capability";
  const mint = (standing: Standing) => () => chatToken(world, standing, ORG_A, CHAT_CHANNELS[ORG_A] ?? [], RIVAL_CHAT);
  return [
    {
      id: "realtime-chat-token-org-member",
      actor: "org:member",
      resource: "chat:realtime-token",
      action: "subscribe",
      tenant: "same",
      state: "normal",
      expected: "allow",
      because: "chat:messages:read is a universal member grant and the capability admits every channel the member sits in",
      bindings: [{ adapter: "realtime", entry, run: mint("org:member") }],
    },
    {
      id: "realtime-chat-token-module-admin",
      actor: "module:admin",
      resource: "chat:realtime-token",
      action: "subscribe",
      tenant: "same",
      state: "normal",
      expected: "allow",
      because: "a member with a module role still mints its own chat token",
      bindings: [{ adapter: "realtime", entry, run: () => chatToken(world, "module:admin", ORG_A, [], RIVAL_CHAT) }],
    },
    {
      id: "realtime-chat-token-outsider",
      actor: "outsider",
      resource: "chat:realtime-token",
      action: "subscribe",
      tenant: "same",
      state: "normal",
      expected: "403",
      because: "with no live membership the resolver returns nothing, so the token route refuses",
      pairedWith: "realtime-chat-token-org-member",
      bindings: [{ adapter: "realtime", entry, run: mint("outsider") }],
    },
    {
      id: "realtime-chat-token-cross-tenant",
      actor: "org:member",
      resource: "chat:realtime-token",
      action: "subscribe",
      tenant: "other",
      state: "normal",
      expected: "404",
      because: "the capability minted for one organisation admits no channel of another",
      pairedWith: "realtime-chat-token-org-member",
      bindings: [{ adapter: "realtime", entry, run: () => chatTokenAcrossTenants(world, "org:member", ORG_A, RIVAL_CHAT) }],
    },
  ];
}

function supportScenarios(world: WorldDb): Scenario[] {
  const entry = "GET /support/ably-token -> Ably capability";
  const own = SUPPORT_TICKETS[ORG_A] ?? [];
  return [
    {
      id: "realtime-support-token-org-admin",
      actor: "org:admin",
      resource: "support:tickets",
      action: "subscribe",
      tenant: "same",
      state: "normal",
      expected: "allow",
      because: "scope all grants one wildcard confined to the caller's org without reading rows",
      bindings: [{ adapter: "realtime", entry, run: () => supportToken(world, "org:admin", ORG_A, RIVAL_SUPPORT, own) }],
    },
    {
      id: "realtime-support-token-org-member",
      actor: "org:member",
      resource: "support:tickets",
      action: "subscribe",
      tenant: "same",
      state: "normal",
      expected: "403",
      because: "scope none grants no channel at all",
      pairedWith: "realtime-support-token-org-admin",
      bindings: [{ adapter: "realtime", entry, run: () => supportToken(world, "org:member", ORG_A, RIVAL_SUPPORT, own) }],
    },
    {
      id: "realtime-support-token-narrowed",
      actor: "module:member",
      resource: "support:tickets",
      action: "subscribe",
      tenant: "same",
      state: "scope-narrowed",
      expected: "allow",
      because: "a narrowed scope grants one channel per ticket the org-bound own-scope query returned",
      bindings: [{ adapter: "realtime", entry, run: () => supportToken(world, "module:member", ORG_A, RIVAL_SUPPORT, own, NARROWED) }],
    },
    {
      id: "realtime-support-token-narrowed-cross-tenant",
      actor: "module:member",
      resource: "support:tickets",
      action: "subscribe",
      tenant: "other",
      state: "scope-narrowed",
      expected: "404",
      because: "the narrowed grant names only the caller's organisation, so no rival ticket channel is admitted",
      pairedWith: "realtime-support-token-narrowed",
      bindings: [
        {
          adapter: "realtime",
          entry,
          run: async (): Promise<Observation> => {
            const observed = await supportToken(world, "module:member", ORG_A, RIVAL_SUPPORT, own, NARROWED);
            return { ...observed, outcome: observed.outcome === "allow" && observed.checks?.noRivalTicketSubscribable === true ? "404" : observed.outcome };
          },
        },
      ],
    },
  ];
}

function sseScenarios(world: WorldDb): Scenario[] {
  const entry = "POST /notifications/events/token then GET /notifications/events (stream)";
  const subject = (standing: Standing, orgId: string) => ({ userId: actorFor(standing, orgId).userId, orgId });
  return [
    {
      id: "realtime-sse-stream-org-member",
      actor: "org:member",
      resource: "notifications:stream",
      action: "subscribe",
      tenant: "same",
      state: "normal",
      expected: "allow",
      because: "the stream opens for exactly the org and user the token was minted for",
      bindings: [
        {
          adapter: "realtime",
          entry,
          run: async () => {
            const attempt = await streamAttempts(world, { standing: "org:member", orgId: ORG_A }, (token) => [token]);
            const opened = attempt.opened[0];
            const expected = subject("org:member", ORG_A);
            return {
              outcome: attempt.minted === "allow" && opened !== null && opened !== undefined ? "allow" : "403",
              checks: { streamBoundToMintedSubject: opened?.orgId === expected.orgId && opened?.userId === expected.userId },
            };
          },
        },
      ],
    },
    {
      id: "realtime-sse-stream-cross-tenant",
      actor: "org:member",
      resource: "notifications:stream",
      action: "subscribe",
      tenant: "other",
      state: "normal",
      expected: "404",
      because: "a token minted in one organisation never opens another organisation's stream",
      pairedWith: "realtime-sse-stream-org-member",
      bindings: [
        {
          adapter: "realtime",
          entry,
          run: async () => {
            const attempt = await streamAttempts(world, { standing: "org:member", orgId: ORG_B }, (token) => [token]);
            const opened = attempt.opened[0];
            return {
              outcome: opened?.orgId === ORG_A ? "allow" : "404",
              checks: { openedItsOwnOrgOnly: opened?.orgId === ORG_B && opened.userId === userOf("org:member", ORG_B) },
            };
          },
        },
      ],
    },
    {
      id: "realtime-sse-stream-replayed",
      actor: "org:member",
      resource: "notifications:stream",
      action: "subscribe",
      tenant: "same",
      state: "replayed",
      expected: "403",
      because: "the stream token is single use so a leaked one cannot be replayed",
      pairedWith: "realtime-sse-stream-org-member",
      bindings: [
        {
          adapter: "realtime",
          entry,
          run: async () => {
            const attempt = await streamAttempts(world, { standing: "org:member", orgId: ORG_A }, (token) => [token, token]);
            return { outcome: attempt.opened[1] === null ? "403" : "allow", checks: { firstUseOpened: attempt.opened[0] !== null } };
          },
        },
      ],
    },
    {
      id: "realtime-sse-stream-forged",
      actor: "outsider",
      resource: "notifications:stream",
      action: "subscribe",
      tenant: "same",
      state: "normal",
      expected: "403",
      because: "a token the server never minted opens nothing",
      pairedWith: "realtime-sse-stream-org-member",
      bindings: [
        {
          adapter: "realtime",
          entry,
          run: async () => {
            const attempt = await streamAttempts(world, { standing: "org:member", orgId: ORG_A }, () => ["not-a-token"]);
            return { outcome: attempt.opened[0] === null ? "403" : "allow" };
          },
        },
      ],
    },
  ];
}

function jobScenarios(world: WorldDb): Scenario[] {
  const entry = "OutboxPublisherService.flush: claim -> tenant transaction -> BuildReleasePublishedConsumerService";
  const assignee = userOf("module:member", ORG_A);
  return [
    {
      id: "job-release-published-same-tenant",
      actor: "tenant-only",
      resource: "build:release",
      action: "notify-assignees",
      tenant: "same",
      state: "normal",
      expected: "allow",
      because: "the relay delivers the event inside its own organisation's transaction and reaches that organisation's assignees",
      bindings: [{ adapter: "job", entry, run: () => releaseNotificationJob(ORG_A, RELEASE_A, ORG_A, [assignee]) }],
    },
    {
      id: "job-release-published-cross-tenant",
      actor: "tenant-only",
      resource: "build:release",
      action: "notify-assignees",
      tenant: "other",
      state: "normal",
      expected: "404",
      because: "an event from another organisation carrying the same release id reaches none of this organisation's assignees",
      pairedWith: "job-release-published-same-tenant",
      bindings: [{ adapter: "job", entry, run: () => releaseNotificationJob(ORG_B, RELEASE_A, ORG_A, [assignee]) }],
    },
    {
      id: "hr-recruiter-remove-same-tenant",
      actor: "tenant-only",
      resource: "hr:recruitment-job",
      action: "remove-recruiter",
      tenant: "same",
      state: "normal",
      expected: "allow",
      because: "removeRecruiter takes only an orgId, so this is a tenant-binding scenario: the org's own job still deletes",
      bindings: [{ adapter: "service", entry: "RecruitmentJobsService.removeRecruiter(orgId)", run: () => recruiterRemoval(world, ORG_A, ORG_A, JOB_A, RECRUITER_A) }],
    },
    {
      id: "hr-recruiter-remove-cross-tenant",
      actor: "tenant-only",
      resource: "hr:recruitment-job",
      action: "remove-recruiter",
      tenant: "other",
      state: "normal",
      expected: "404",
      because: "the ownership lookup binds the caller's org so another org's job is not found and nothing is deleted",
      pairedWith: "hr-recruiter-remove-same-tenant",
      bindings: [{ adapter: "service", entry: "RecruitmentJobsService.removeRecruiter(orgId)", run: () => recruiterRemoval(world, ORG_B, ORG_A, JOB_A, RECRUITER_A) }],
    },
  ];
}

export function runtimeScenarios(world: WorldDb): Scenario[] {
  return [...chatScenarios(world), ...supportScenarios(world), ...sseScenarios(world), ...jobScenarios(world)];
}
