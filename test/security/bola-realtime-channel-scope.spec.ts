import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AblyService } from "src/modules/realtime/ably.service";
import type { AppConfig } from "src/config/env.validation";

const BACKEND_ROOT = join(__dirname, "../..");

function src(rel: string): string {
  return readFileSync(join(BACKEND_ROOT, rel), "utf8");
}

function makeAblyService(cellId: string): AblyService {
  const config: Pick<AppConfig, "ABLY_API_KEY" | "CELL_ID"> = {
    ABLY_API_KEY: undefined,
    CELL_ID: cellId,
  };
  return new AblyService(config);
}

describe("AblyService — realtime channel tenant isolation (BOLA)", () => {
  it("CROSS-TENANT-CHANNEL: channel name for org-A differs from org-B for the same channel ID", () => {
    const svc = makeAblyService("cell-1");
    const channelA = svc.channelName("org-a", 42);
    const channelB = svc.channelName("org-b", 42);
    expect(channelA).not.toEqual(channelB);
  });

  it("CHANNEL-NAMESPACE: channel name embeds the orgId preventing cross-org subscription", () => {
    const svc = makeAblyService("cell-1");
    const channelForOrgA = svc.channelName("org-a", 7);
    expect(channelForOrgA).toContain("org-a");
    expect(channelForOrgA).not.toContain("org-b");
  });

  it("CHANNEL-NAMESPACE: same orgId with different channelIds produces different channel names", () => {
    const svc = makeAblyService("cell-1");
    const ch1 = svc.channelName("org-a", 1);
    const ch2 = svc.channelName("org-a", 2);
    expect(ch1).not.toEqual(ch2);
  });

  it("CELL-PREFIX: channel names include cell prefix for cell-level namespace isolation", () => {
    const svcCell1 = makeAblyService("cell-1");
    const svcCell2 = makeAblyService("cell-2");
    const channelCell1 = svcCell1.channelName("org-a", 1);
    const channelCell2 = svcCell2.channelName("org-a", 1);
    expect(channelCell1).not.toEqual(channelCell2);
    expect(channelCell1).toContain("cell-1");
    expect(channelCell2).toContain("cell-2");
  });
});

describe("AblyService source — capability map binds orgId in channel names (static analysis)", () => {
  const ablySrc = src("src/modules/realtime/ably.service.ts");

  it("notification channel capability embeds orgId", () => {
    expect(ablySrc).toMatch(/`notifications:\$\{orgId\}:/);
  });

  it("chat channel capability embeds orgId and channelId", () => {
    expect(ablySrc).toMatch(/`chat:\$\{orgId\}:\$\{channelId\}`/);
  });

  it("huddle channel capability embeds orgId", () => {
    expect(ablySrc).toMatch(/`huddle[^`]*:\$\{orgId\}/);
  });

  it("capability map uses cellPrefixed so channel names are cell-scoped", () => {
    expect(ablySrc).toMatch(/cellPrefixed/);
  });

  it("createChatTokenRequest derives channel list from listMemberChannelIds not from request body", () => {
    const chatRealtimeSrc = src("src/modules/chat/chat-realtime.controller.ts");
    expect(chatRealtimeSrc).toMatch(/listMemberChannelIds\s*\(\s*u\.orgId\s*,\s*u\.userId\s*\)/);
  });

  it("chat controller sets clientId to u.userId (not a client-supplied value)", () => {
    expect(ablySrc).not.toMatch(/clientId.*req\./);
    const chatRealtimeSrc = src("src/modules/chat/chat-realtime.controller.ts");
    expect(chatRealtimeSrc).toMatch(/createChatTokenRequest\s*\(\s*u\.userId\s*,\s*u\.orgId/);
  });
});

describe("Realtime token revocation — orgId payload validation (static analysis)", () => {
  const revocationSrc = src("src/modules/realtime/realtime-token-revocation.ts");

  it("token revocation validates orgId from payload matches the outbox event organization", () => {
    expect(revocationSrc).toMatch(/parsed\.data\.orgId\s*!==\s*event\.organizationId/);
  });

  it("revocation payload schema requires orgId as a non-empty string", () => {
    expect(revocationSrc).toMatch(/orgId:\s*z\.string\(\)\.min\(1\)/);
  });
});
