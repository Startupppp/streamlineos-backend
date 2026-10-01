import { ChatRealtimeController } from "src/modules/chat/chat-realtime.controller";
import type { ExecutableCell } from "../matrix.types";
import { probeHttp } from "../adapters/http-adapter";
import {
  chatGrantCrossTenant,
  chatGrantSameTenant,
  sseTokenCrossTenant,
  sseTokenMinted,
  sseTokenReplayed,
  sseTokenUnknown,
  supportGrant,
  supportGrantCrossTenant,
} from "../adapters/realtime-adapter";
import { releaseNotification } from "../adapters/job-adapter";
import { recruiterRemoval } from "../adapters/service-adapter";
import { ORG_A, ORG_B } from "../standings";
import type { WorldDb } from "../world-db";
import { JOB_A, RECRUITER_A, RELEASE_A, RELEASE_ASSIGNEE_A } from "../fixtures";

const NARROWED = { "support:tickets:view": "own" } as const;

function chatCells(world: WorldDb): ExecutableCell[] {
  const token = (standing: "org:member" | "outsider") => () =>
    probeHttp(world, {
      controllers: [ChatRealtimeController],
      verb: "get",
      path: "/chat/ably-token",
      permissionKey: "chat:messages:read",
      standing,
      orgId: ORG_A,
    });
  return [
    {
      kind: "executable",
      id: "realtime-chat-token-http-org-member",
      standing: "org:member",
      resource: "chat:realtime-token",
      action: "mint",
      tenant: "same",
      state: "normal",
      expected: "allow",
      adapter: "realtime",
      because: "chat:messages:read is a universal member grant",
      run: token("org:member"),
    },
    {
      kind: "executable",
      id: "realtime-chat-token-http-outsider",
      standing: "outsider",
      resource: "chat:realtime-token",
      action: "mint",
      tenant: "same",
      state: "normal",
      expected: "403",
      adapter: "realtime",
      because: "with no live membership the resolver returns nothing, so the token route refuses",
      pairedWith: "realtime-chat-token-http-org-member",
      run: token("outsider"),
    },
    {
      kind: "executable",
      id: "realtime-chat-grant-same-tenant",
      standing: "org:member",
      resource: "chat:channels",
      action: "grant-at-mint",
      tenant: "same",
      state: "normal",
      expected: "allow",
      adapter: "realtime",
      because: "the grant reads channels with the token's own org and user and names only that org",
      run: () => chatGrantSameTenant("org:member", ORG_A, ORG_B),
    },
    {
      kind: "executable",
      id: "realtime-chat-grant-cross-tenant",
      standing: "org:member",
      resource: "chat:channels",
      action: "grant-at-mint",
      tenant: "other",
      state: "normal",
      expected: "404",
      adapter: "realtime",
      because: "two orgs holding the same channel ids receive disjoint capability keys",
      pairedWith: "realtime-chat-grant-same-tenant",
      run: () => chatGrantCrossTenant("org:member", ORG_A, ORG_B),
    },
  ];
}

function supportCells(world: WorldDb): ExecutableCell[] {
  return [
    {
      kind: "executable",
      id: "realtime-support-grant-org-admin",
      standing: "org:admin",
      resource: "support:tickets",
      action: "grant-at-mint",
      tenant: "same",
      state: "normal",
      expected: "allow",
      adapter: "realtime",
      because: "scope all grants one wildcard confined to the caller's org without reading rows",
      run: () => supportGrant(world, "org:admin", ORG_A, ORG_B),
    },
    {
      kind: "executable",
      id: "realtime-support-grant-org-member",
      standing: "org:member",
      resource: "support:tickets",
      action: "grant-at-mint",
      tenant: "same",
      state: "normal",
      expected: "403",
      adapter: "realtime",
      because: "scope none grants no channel at all",
      pairedWith: "realtime-support-grant-org-admin",
      run: () => supportGrant(world, "org:member", ORG_A, ORG_B),
    },
    {
      kind: "executable",
      id: "realtime-support-grant-narrowed",
      standing: "module:member",
      resource: "support:tickets",
      action: "grant-at-mint",
      tenant: "same",
      state: "scope-narrowed",
      expected: "allow",
      adapter: "realtime",
      because: "a narrowed scope grants one channel per row the org-bound query returned",
      run: () => supportGrant(world, "module:member", ORG_A, ORG_B, NARROWED),
    },
    {
      kind: "executable",
      id: "realtime-support-grant-narrowed-cross-tenant",
      standing: "module:member",
      resource: "support:tickets",
      action: "grant-at-mint",
      tenant: "other",
      state: "scope-narrowed",
      expected: "404",
      adapter: "realtime",
      because: "the same ticket ids in another org produce a disjoint grant",
      pairedWith: "realtime-support-grant-narrowed",
      run: () => supportGrantCrossTenant(world, "module:member", ORG_A, ORG_B, NARROWED),
    },
  ];
}

function sseCells(): ExecutableCell[] {
  const base = {
    kind: "executable",
    resource: "notifications:sse-token",
    action: "consume",
    adapter: "realtime",
  } as const;
  return [
    {
      ...base,
      id: "realtime-sse-token-minted",
      standing: "org:member",
      tenant: "same",
      state: "normal",
      expected: "allow",
      because: "a stream token resolves to exactly the org and user it was minted for",
      run: async () => sseTokenMinted("org:member", ORG_A),
    },
    {
      ...base,
      id: "realtime-sse-token-cross-tenant",
      standing: "org:member",
      tenant: "other",
      state: "normal",
      expected: "404",
      because: "a token minted in one org never resolves to another",
      pairedWith: "realtime-sse-token-minted",
      run: async () => sseTokenCrossTenant("org:member", ORG_A, ORG_B),
    },
    {
      ...base,
      id: "realtime-sse-token-replayed",
      standing: "org:member",
      tenant: "same",
      state: "replayed",
      expected: "403",
      because: "the token is single use so a leaked one cannot be replayed",
      pairedWith: "realtime-sse-token-minted",
      run: async () => sseTokenReplayed("org:member", ORG_A),
    },
    {
      ...base,
      id: "realtime-sse-token-unknown",
      standing: "outsider",
      tenant: "same",
      state: "normal",
      expected: "403",
      because: "an unknown token grants nothing",
      pairedWith: "realtime-sse-token-minted",
      run: async () => sseTokenUnknown(),
    },
  ];
}

function jobAndHrCells(world: WorldDb): ExecutableCell[] {
  return [
    {
      kind: "executable",
      id: "job-release-published-same-tenant",
      standing: "module:member",
      resource: "build:release",
      action: "notify-assignees",
      tenant: "same",
      state: "normal",
      expected: "allow",
      adapter: "job",
      because: "the consumer reaches assignees of the event's own organisation",
      run: () => releaseNotification(world, ORG_A, RELEASE_A, ORG_A, [RELEASE_ASSIGNEE_A]),
    },
    {
      kind: "executable",
      id: "job-release-published-cross-tenant",
      standing: "module:member",
      resource: "build:release",
      action: "notify-assignees",
      tenant: "other",
      state: "normal",
      expected: "404",
      adapter: "job",
      because: "an event from another organisation carrying the same release id reaches none of this org's assignees",
      pairedWith: "job-release-published-same-tenant",
      run: () => releaseNotification(world, ORG_B, RELEASE_A, ORG_A, [RELEASE_ASSIGNEE_A]),
    },
    {
      kind: "executable",
      id: "hr-recruiter-remove-same-tenant",
      standing: "org:admin",
      resource: "hr:recruitment-job",
      action: "remove-recruiter",
      tenant: "same",
      state: "normal",
      expected: "allow",
      adapter: "service",
      because: "the owner's own job still deletes so the guard is not a blanket denial",
      run: () => recruiterRemoval(world, ORG_A, ORG_A, JOB_A, RECRUITER_A),
    },
    {
      kind: "executable",
      id: "hr-recruiter-remove-cross-tenant",
      standing: "org:admin",
      resource: "hr:recruitment-job",
      action: "remove-recruiter",
      tenant: "other",
      state: "normal",
      expected: "404",
      adapter: "service",
      because: "the ownership lookup binds the caller's org so another org's job is not found and nothing is deleted",
      pairedWith: "hr-recruiter-remove-same-tenant",
      run: () => recruiterRemoval(world, ORG_B, ORG_A, JOB_A, RECRUITER_A),
    },
  ];
}

export function runtimeCells(world: WorldDb): ExecutableCell[] {
  return [...chatCells(world), ...supportCells(world), ...sseCells(), ...jobAndHrCells(world)];
}
