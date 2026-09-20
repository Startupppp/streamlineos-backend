jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: <T,>(_db: unknown, fn: () => Promise<T>) => fn(),
  runInNewTenantTransaction: <T,>(_db: unknown, _orgId: string, fn: () => Promise<T>) => fn(),
}));

import { MailCopilotTools } from "./mail-copilot-tools";
import { resolveAnyMailConnection } from "./lib/mail-connection";
import { resolveToolkitConnection } from "../../../integrations/core/connection-resolution";
import type { Db } from "../../../../db/drizzle.module";
import type { AskOsToolRunContext } from "../registry/ask-os-tool.types";
import { ScopedRead } from "../../../access/scoped-read";
import type { AskOsActor } from "../services/ask-os-actor";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

jest.mock("../../../integrations/core/connection-resolution");

const mockedResolve = jest.mocked(resolveToolkitConnection);
const mockDb = {} as Db;
const subject = { orgId: "org-1", userId: "user-1", membershipId: 42 };

const NO_CONNECTION = { status: "unresolved" as const, reason: "no-connection" as const };
const NEEDS_REAUTH = { status: "unresolved" as const, reason: "needs-reauth" as const };
const RESOLVED = {
  status: "resolved" as const,
  connection: {
    connectionId: 1,
    composioConnectedAccountId: "cca-1",
    composioUserId: "cu-1",
    scope: "user" as const,
    accountEmail: "test@gmail.com",
  },
};

function bothReturn(
  gmailResult: typeof NO_CONNECTION | typeof NEEDS_REAUTH | typeof RESOLVED,
  outlookResult: typeof NO_CONNECTION | typeof NEEDS_REAUTH | typeof RESOLVED,
) {
  mockedResolve.mockImplementation((_db, sub) =>
    Promise.resolve(sub.toolkit === "gmail" ? gmailResult : outlookResult),
  );
}

describe("resolveAnyMailConnection — distinguishes states the UI acts on differently", () => {
  beforeEach(() => jest.clearAllMocks());

  it("reports no-connection when neither gmail nor outlook is connected", async () => {
    bothReturn(NO_CONNECTION, NO_CONNECTION);
    const result = await resolveAnyMailConnection(mockDb, subject);
    expect(result).toMatchObject({ connected: false, reason: "no-connection" });
  });

  it("reports needs-reauth when gmail is stale and outlook is absent", async () => {
    bothReturn(NEEDS_REAUTH, NO_CONNECTION);
    const result = await resolveAnyMailConnection(mockDb, subject);
    expect(result).toMatchObject({ connected: false, reason: "needs-reauth" });
  });

  it("reports needs-reauth via outlook when gmail is absent and outlook is stale", async () => {
    bothReturn(NO_CONNECTION, NEEDS_REAUTH);
    const result = await resolveAnyMailConnection(mockDb, subject);
    expect(result).toMatchObject({ connected: false, reason: "needs-reauth" });
  });

  it("the two unresolved states differ so the UI renders Connect vs Reconnect", async () => {
    bothReturn(NO_CONNECTION, NO_CONNECTION);
    const noConn = await resolveAnyMailConnection(mockDb, subject);

    bothReturn(NEEDS_REAUTH, NO_CONNECTION);
    const stale = await resolveAnyMailConnection(mockDb, subject);

    expect(noConn).not.toEqual(stale);
  });

  it("reports connected when gmail resolves even if outlook does not", async () => {
    bothReturn(RESOLVED, NO_CONNECTION);
    expect(await resolveAnyMailConnection(mockDb, subject)).toEqual({ connected: true });
  });

  it("reports connected when outlook resolves even if gmail does not", async () => {
    bothReturn(NO_CONNECTION, RESOLVED);
    expect(await resolveAnyMailConnection(mockDb, subject)).toEqual({ connected: true });
  });

  it("reports connected when both resolve", async () => {
    bothReturn(RESOLVED, RESOLVED);
    expect(await resolveAnyMailConnection(mockDb, subject)).toEqual({ connected: true });
  });
});

const actor: AskOsActor = {
  userId: "u1",
  orgId: "org1",
  membershipId: 7,
  displayName: "Alice",
  email: "alice@org.com",
  orgName: "Org",
  role: "MEMBER",
  isOrgOwner: false,
  timezone: "UTC",
  today: "2026-09-19",
  monthStart: "2026-09-01",
  monthEnd: "2026-09-30",
  currentYear: 2026,
  currentMonth: 9,
};

const caller: CurrentUserContext = {
  userId: "u1",
  orgId: "org1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s1",
  tokenScopes: null,
  principal: {} as CurrentUserContext["principal"],
};

const ctx: AskOsToolRunContext = {
  actor,
  caller,
  read: ScopedRead.of(actor.orgId, actor.userId, "all"),
  readFor: () => ScopedRead.of(actor.orgId, actor.userId, "all"),
  modules: {},
};

const mockMail = { listAccounts: jest.fn(), listMessages: jest.fn() };
const mockMailAi = { threadSummary: jest.fn() };
const mockConfirmation = { propose: jest.fn() };

function makeTools() {
  const instance = new MailCopilotTools(
    mockDb,
    mockMail as never,
    mockMailAi as never,
    mockConfirmation as never,
  );
  return instance.tools();
}

describe("listRecentEmails — connection gate fires before any mail call", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns needs-connection with no-connection when neither toolkit is connected", async () => {
    bothReturn(NO_CONNECTION, NO_CONNECTION);
    const tool = makeTools().find((t) => t.key === "listRecentEmails")!;
    const result = await tool.run({ folder: "inbox" }, ctx);
    expect(result).toMatchObject({ kind: "needs-connection", reason: "no-connection" });
    expect(mockMail.listAccounts).not.toHaveBeenCalled();
  });

  it("returns needs-connection with needs-reauth when connection is stale", async () => {
    bothReturn(NEEDS_REAUTH, NO_CONNECTION);
    const tool = makeTools().find((t) => t.key === "listRecentEmails")!;
    const result = await tool.run({ folder: "inbox" }, ctx);
    expect(result).toMatchObject({ kind: "needs-connection", reason: "needs-reauth" });
  });

  it("the two connection outcomes are structurally distinct", async () => {
    const tool = makeTools().find((t) => t.key === "listRecentEmails")!;

    bothReturn(NO_CONNECTION, NO_CONNECTION);
    const noConn = await tool.run({ folder: "inbox" }, ctx);

    bothReturn(NEEDS_REAUTH, NO_CONNECTION);
    const stale = await tool.run({ folder: "inbox" }, ctx);

    expect(noConn).not.toEqual(stale);
  });

  it("proceeds to list messages when a toolkit resolves", async () => {
    bothReturn(RESOLVED, NO_CONNECTION);
    mockMail.listAccounts.mockResolvedValue([
      { id: 1, accountEmail: "a@b.com", isPrimary: true },
    ]);
    mockMail.listMessages.mockResolvedValue({
      messages: [
        { subject: "Hi", from: { email: "x@y.com" }, date: "2026-09-01", snippet: "Hey", isRead: false },
      ],
    });
    const tool = makeTools().find((t) => t.key === "listRecentEmails")!;
    const result = await tool.run({ folder: "inbox" }, ctx);
    expect(result).toMatchObject({ kind: "data" });
    expect(mockMail.listAccounts).toHaveBeenCalledWith("org1", "u1");
  });
});

describe("MailCopilotTools tool registry metadata", () => {
  it("exposes the correct key, permission, and module for each tool", () => {
    const tools = makeTools();
    const byKey = Object.fromEntries(tools.map((t) => [t.key, t]));
    expect(byKey["listRecentEmails"]).toMatchObject({ permission: "mail:inbox:view", module: "mail" });
    expect(byKey["summarizeMailThread"]).toMatchObject({ permission: "mail:ai:use", module: "mail" });
    expect(byKey["sendMailFromAccount"]).toMatchObject({ permission: "mail:messages:send", module: "mail" });
  });
});
