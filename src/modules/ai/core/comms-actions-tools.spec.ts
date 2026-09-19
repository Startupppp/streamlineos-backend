import { CommsActionsTools } from "./comms-actions-tools";
import type { Db } from "../../../db/drizzle.module";
import type { ChatChannelsService } from "../../chat/chat-channels.service";
import type { AiConfirmationService } from "../confirmation/ai-confirmation.service";
import type { AskOsActor } from "./services/ask-os-actor";
import type { AskOsToolDefinition, AskOsToolRunContext } from "./registry/ask-os-tool.types";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

function makeActor(): AskOsActor {
  return {
    userId: "user-test",
    orgId: "org-test",
    membershipId: 42,
    displayName: "Test User",
    email: "test@org.com",
    orgName: "Test Org",
    role: "MEMBER",
    isOrgOwner: false,
    timezone: "UTC",
    today: "2026-09-18",
    monthStart: "2026-09-01",
    monthEnd: "2026-09-30",
    currentYear: 2026,
    currentMonth: 9,
  };
}

function makeCaller(): CurrentUserContext {
  return {
    userId: "user-test",
    orgId: "org-test",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-test",
    tokenScopes: null,
    principal: humanSessionPrincipal(42, false),
  };
}

function makeCtx(scope: AskOsToolRunContext["scope"] = "all"): AskOsToolRunContext {
  return {
    actor: makeActor(),
    caller: makeCaller(),
    scope,
    scopes: { "chat:messages:write": scope },
    modules: {},
  };
}

function findTool(defs: AskOsToolDefinition[], key: string): AskOsToolDefinition {
  const def = defs.find((d) => d.key === key);
  if (!def) throw new Error(`Tool "${key}" not found`);
  return def;
}

function buildInstance({
  memberChannelIds,
  dbChannelResult,
}: {
  memberChannelIds: number[];
  dbChannelResult: Array<{ id: number; name: string }>;
}): CommsActionsTools {
  const limitFn = jest.fn().mockResolvedValue(dbChannelResult);
  const whereFn = jest.fn().mockReturnValue({ limit: limitFn });
  const fromFn = jest.fn().mockReturnValue({ where: whereFn });
  const db = { select: jest.fn().mockReturnValue({ from: fromFn }) } as unknown as Db;

  const confirmation = {
    propose: jest.fn().mockResolvedValue({
      proposalId: 1,
      token: "tok-1",
      expiresAt: new Date(),
    }),
  } as unknown as AiConfirmationService;

  const channels = {
    listMemberChannelIds: jest.fn().mockResolvedValue(memberChannelIds),
  } as unknown as ChatChannelsService;

  return new CommsActionsTools(db, confirmation, channels);
}

describe("CommsActionsTools.postChannelMessage — membership-gated channel resolution", () => {
  it("returns not-found when the actor belongs to no channels", async () => {
    const tools = findTool(
      buildInstance({ memberChannelIds: [], dbChannelResult: [] }).tools(),
      "postChannelMessage",
    );
    const result = await tools.run({ channelName: "secret-dm", message: "hi" }, makeCtx());
    expect(result).toMatchObject({ kind: "empty" });
  });

  it("returns not-found for a PRIVATE channel not in the actor's membership", async () => {
    const tools = findTool(
      buildInstance({ memberChannelIds: [1], dbChannelResult: [] }).tools(),
      "postChannelMessage",
    );
    const result = await tools.run({ channelName: "secret-private", message: "hi" }, makeCtx());
    expect(result).toMatchObject({ kind: "empty" });
  });

  it("returns not-found for a DIRECT channel the actor is not a member of", async () => {
    const tools = findTool(
      buildInstance({ memberChannelIds: [2], dbChannelResult: [] }).tools(),
      "postChannelMessage",
    );
    const result = await tools.run({ channelName: "user-dm-thread", message: "hi" }, makeCtx());
    expect(result).toMatchObject({ kind: "empty" });
  });

  it("does not mint a confirmation proposal for an inaccessible channel", async () => {
    const tools = findTool(
      buildInstance({ memberChannelIds: [1], dbChannelResult: [] }).tools(),
      "postChannelMessage",
    );
    const result = await tools.run({ channelName: "private-board", message: "hi" }, makeCtx());
    expect(result).not.toHaveProperty("proposalId");
    expect(result).not.toHaveProperty("requiresConfirmation");
  });

  it("gives the same response for a non-member channel as for a channel that does not exist", async () => {
    const notMemberResult = await findTool(
      buildInstance({ memberChannelIds: [1], dbChannelResult: [] }).tools(),
      "postChannelMessage",
    ).run({ channelName: "secret-chan", message: "x" }, makeCtx());

    const nonExistentResult = await findTool(
      buildInstance({ memberChannelIds: [], dbChannelResult: [] }).tools(),
      "postChannelMessage",
    ).run({ channelName: "secret-chan", message: "x" }, makeCtx());

    expect(notMemberResult).toEqual(nonExistentResult);
  });

  it("resolves and proposes when the actor is a member of the matching channel", async () => {
    const tools = findTool(
      buildInstance({
        memberChannelIds: [10],
        dbChannelResult: [{ id: 10, name: "general" }],
      }).tools(),
      "postChannelMessage",
    );
    const result = await tools.run({ channelName: "general", message: "hello team" }, makeCtx());
    expect(result).toMatchObject({ kind: "needs-confirmation", action: "chat.postChannel" });
  });
});
