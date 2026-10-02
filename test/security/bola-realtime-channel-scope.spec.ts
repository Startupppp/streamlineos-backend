import { readFileSync } from "node:fs";
import { join } from "node:path";

const BACKEND_ROOT = join(__dirname, "../..");

function src(rel: string): string {
  return readFileSync(join(BACKEND_ROOT, rel), "utf8");
}

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

  it("createChatTokenRequest derives channel list from listMemberChannelIds over the token's own actor, not from request body", () => {
    const chatRealtimeSrc = src("src/modules/chat/chat-realtime.controller.ts");
    expect(chatRealtimeSrc).toMatch(/listMemberChannelIds\s*\(\s*actorOf\s*\(\s*u\s*\)\s*\)/);
    expect(chatRealtimeSrc).toMatch(/@CurrentUser\(\)\s*u:\s*CurrentUserContext/);
    expect(src("src/modules/entity-reference/entity-actor.ts")).toMatch(/orgId:\s*u\.orgId,\s*userId:\s*u\.userId/);
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
