jest.mock("./lib/mail-connection", () => ({
  requireMailConnection: jest.fn(),
}));
jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
}));

import { CommsActionsTools } from "./comms-actions-tools";
import type { Db } from "../../../../db/drizzle.module";
import type { TenantTx } from "../../../../db/drizzle.types";
import type { ChatChannelsService } from "../../../chat/chat-channels.service";
import type { AiConfirmationService } from "../../confirmation/ai-confirmation.service";
import type { MailService } from "../../../mail/mail.service";
import type { AskOsActor } from "../services/ask-os-actor";
import type { AskOsToolDefinition, AskOsToolRunContext } from "../registry/ask-os-tool.types";
import type { DataScope } from "../../../access/access.types";
import { ScopedRead } from "../../../access/scoped-read";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { requireMailConnection } from "./lib/mail-connection";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";

const mockedRequireMailConnection = jest.mocked(requireMailConnection);
const mockedRunInNewTenantTransaction = jest.mocked(runInNewTenantTransaction);

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

function makeCtx(scope: DataScope = "all"): AskOsToolRunContext {
  const actor = makeActor();
  const read = ScopedRead.of(actor.orgId, actor.userId, scope);
  return {
    actor,
    caller: makeCaller(),
    read,
    readFor: () => read,
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
  mail,
}: {
  memberChannelIds: number[];
  dbChannelResult: Array<{ id: number; name: string }>;
  mail?: Partial<MailService>;
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

  const mailService = (mail ?? {}) as unknown as MailService;

  return new CommsActionsTools(db, confirmation, channels, mailService);
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

interface CaptureQueryChain {
  from: jest.Mock;
  innerJoin: jest.Mock;
  where: jest.Mock;
  limit: jest.Mock;
}

describe("CommsActionsTools.grantBonus — soft-delete safety", () => {
  function captureDb() {
    const capturedWheres: SQL[] = [];
    const chain: CaptureQueryChain = {
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn((cond: SQL) => {
        capturedWheres.push(cond);
        return chain;
      }),
      limit: jest.fn(() => Promise.resolve([])),
    };
    const db = { select: jest.fn(() => chain) } as unknown as Db;
    return { db, capturedWheres };
  }

  function buildForGrantBonus(db: Db): CommsActionsTools {
    const confirmation = {
      propose: jest.fn().mockResolvedValue({ proposalId: 1, token: "tok-1", expiresAt: new Date() }),
    } as unknown as AiConfirmationService;
    const channels = {
      listMemberChannelIds: jest.fn().mockResolvedValue([]),
    } as unknown as ChatChannelsService;
    return new CommsActionsTools(db, confirmation, channels, {} as unknown as MailService);
  }

  it("excludes deleted users from the employee lookup: deleted_at is null is in the predicate", async () => {
    const { db, capturedWheres } = captureDb();
    const instance = buildForGrantBonus(db);
    const tool = findTool(instance.tools(), "grantBonus");

    await tool.run(
      { employeeId: "u-1", type: "SPOT", amount: 500, reason: "great work", month: "2026-09", taxable: true },
      makeCtx(),
    );

    expect(capturedWheres).toHaveLength(1);
    const { sql } = new PgDialect().sqlToQuery(capturedWheres[0] as SQL);
    expect(sql).toContain("deleted_at");
    expect(sql.toLowerCase()).toContain("is null");
  });

  it("returns empty when no active employee is found, never proposing on a ghost record", async () => {
    const { db } = captureDb();
    const instance = buildForGrantBonus(db);
    const tool = findTool(instance.tools(), "grantBonus");

    const result = await tool.run(
      { employeeId: "ghost-id", type: "SPOT", amount: 100, reason: "x", month: "2026-09", taxable: true },
      makeCtx(),
    );

    expect(result).toMatchObject({ kind: "empty", subject: "employee" });
  });
});

describe("CommsActionsTools.archiveMailMessage — tool registration and connection gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("registers with confirms: mail.archive and derives its permission from the confirmable-action registry, so the tool source never hand-codes a permission key", () => {
    const instance = buildInstance({ memberChannelIds: [], dbChannelResult: [] });
    const tool = findTool(instance.tools(), "archiveMailMessage");

    expect(tool.confirms).toBe("mail.archive");
    expect(tool.permission).toBe("mail:messages:manage");
  });

  it("returns needs-connection when the actor has no connected mailbox, so no proposal is minted for an impossible action", async () => {
    const needsConnectionOutcome = {
      kind: "needs-connection" as const,
      toolkit: "gmail" as const,
      reason: "no-connection" as const,
      summary: "Connect a mail account to archive messages.",
    };
    mockedRequireMailConnection.mockResolvedValueOnce({
      connected: false,
      outcome: needsConnectionOutcome,
    });
    const instance = buildInstance({ memberChannelIds: [], dbChannelResult: [] });
    const tool = findTool(instance.tools(), "archiveMailMessage");

    const result = await tool.run({ messageId: "msg-1" }, makeCtx());

    expect(result).toMatchObject({ kind: "needs-connection" });
  });

  it("strips a userId field from its input schema, so a caller cannot substitute the actor subject via tool arguments", () => {
    const instance = buildInstance({ memberChannelIds: [], dbChannelResult: [] });
    const tool = findTool(instance.tools(), "archiveMailMessage");
    const parsed = tool.input.safeParse({ messageId: "msg-1", userId: "attacker-id" });

    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("userId");
  });

  it("calls confirmation.propose only after runInNewTenantTransaction resolves, so the provider call is never awaited inside a tenant transaction", async () => {
    const callOrder: string[] = [];

    mockedRequireMailConnection.mockResolvedValueOnce({ connected: true });
    mockedRunInNewTenantTransaction.mockImplementation(async (_db, _orgId, fn) => {
      callOrder.push("txn-start");
      const result = await fn({} as unknown as TenantTx);
      callOrder.push("txn-end");
      return result;
    });

    const mockPropose = jest.fn().mockImplementation(async () => {
      callOrder.push("propose");
      return { proposalId: 1, token: "tok-1", expiresAt: new Date() };
    });
    const confirmation = { propose: mockPropose } as unknown as AiConfirmationService;
    const mailSvc = {
      listAccounts: jest.fn().mockResolvedValue([
        { id: 3, status: "active", accountEmail: "me@example.com", isPrimary: true },
      ]),
    } as unknown as MailService;

    const limitFn = jest.fn().mockResolvedValue([]);
    const db = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: limitFn }) }) }),
    } as unknown as Db;
    const channels = { listMemberChannelIds: jest.fn().mockResolvedValue([]) } as unknown as ChatChannelsService;
    const instance = new CommsActionsTools(db, confirmation, channels, mailSvc);
    const tool = findTool(instance.tools(), "archiveMailMessage");

    await tool.run({ messageId: "msg-1" }, makeCtx());

    expect(callOrder).toEqual(["txn-start", "txn-end", "propose"]);
  });
});
