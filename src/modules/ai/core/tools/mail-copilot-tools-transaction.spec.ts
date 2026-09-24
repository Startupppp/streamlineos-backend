const txCalls: string[] = [];
let insideTx = false;

jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: <T,>(_db: unknown, fn: () => Promise<T>) => fn(),
  runInNewTenantTransaction: <T,>(_db: unknown, orgId: string, fn: () => Promise<T>): Promise<T> => {
    txCalls.push(orgId as string);
    insideTx = true;
    const result = fn();
    return result.finally(() => {
      insideTx = false;
    }) as Promise<T>;
  },
}));

jest.mock("../../../integrations/core/connection-resolution");

import { MailCopilotTools } from "./mail-copilot-tools";
import { resolveToolkitConnection } from "../../../integrations/core/connection-resolution";
import type { Db } from "../../../../db/drizzle.module";
import type { AskOsToolRunContext } from "../registry/ask-os-tool.types";
import { ScopedRead } from "../../../access/scoped-read";
import type { AskOsActor } from "../services/ask-os-actor";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

const mockedResolve = jest.mocked(resolveToolkitConnection);
const mockDb = {} as Db;

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
  today: "2026-09-20",
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

const mockMail = {
  listAccounts: jest.fn(),
  listMessages: jest.fn(),
};
const mockMailAi = { threadSummary: jest.fn() };
const mockConfirmation = { propose: jest.fn() };

function makeTools() {
  return new MailCopilotTools(
    mockDb,
    mockMail as never,
    mockMailAi as never,
    mockConfirmation as never,
  ).tools();
}

function findTool(key: string) {
  const tool = makeTools().find((t) => t.key === key);
  if (!tool) throw new Error(`Tool not found: ${key}`);
  return tool;
}

beforeEach(() => {
  jest.clearAllMocks();
  txCalls.length = 0;
  insideTx = false;
});

describe("listRecentEmails — PRD-14.1: transaction boundary", () => {
  it("declares ownsTransaction so the registry does not hold a pooled connection during the Composio HTTP call", () => {
    const tool = findTool("listRecentEmails");
    expect(tool.ownsTransaction).toBe(true);
  });

  it("resolveToolkitConnection is called inside a runInNewTenantTransaction — DB read has tenant GUC", async () => {
    let dbReadCalledInTx = false;
    mockedResolve.mockImplementation(() => {
      dbReadCalledInTx = insideTx;
      return Promise.resolve(RESOLVED);
    });
    mockMail.listAccounts.mockResolvedValue([
      { id: 1, accountEmail: "a@b.com", isPrimary: true },
    ]);
    mockMail.listMessages.mockResolvedValue({ messages: [] });

    const tool = findTool("listRecentEmails");
    await tool.run({ folder: "inbox" }, ctx);

    expect(dbReadCalledInTx).toBe(true);
    expect(txCalls).toContain("org1");
  });

  it("listMessages is called outside any runInNewTenantTransaction — provider call does not hold a pooled connection", async () => {
    mockedResolve.mockResolvedValue(RESOLVED);
    mockMail.listAccounts.mockResolvedValue([
      { id: 1, accountEmail: "a@b.com", isPrimary: true },
    ]);
    let listMessagesCalledInTx = false;
    mockMail.listMessages.mockImplementation(() => {
      listMessagesCalledInTx = insideTx;
      return Promise.resolve({
        messages: [
          { subject: "Hi", from: { email: "x@y.com" }, date: "2026-09-20", snippet: "Hey", isRead: false },
        ],
      });
    });

    const tool = findTool("listRecentEmails");
    await tool.run({ folder: "inbox" }, ctx);

    expect(listMessagesCalledInTx).toBe(false);
  });
});

describe("summarizeMailThread — PRD-14.1: transaction boundary", () => {
  it("declares ownsTransaction so the registry does not hold a pooled connection during the AI gateway call", () => {
    const tool = findTool("summarizeMailThread");
    expect(tool.ownsTransaction).toBe(true);
  });

  it("resolveToolkitConnection is called inside a runInNewTenantTransaction — DB read has tenant GUC", async () => {
    let dbReadCalledInTx = false;
    mockedResolve.mockImplementation(() => {
      dbReadCalledInTx = insideTx;
      return Promise.resolve(RESOLVED);
    });
    mockMail.listAccounts.mockResolvedValue([
      { id: 1, accountEmail: "a@b.com", isPrimary: true },
    ]);
    mockMailAi.threadSummary.mockResolvedValue({ summary: "test summary" });

    const tool = findTool("summarizeMailThread");
    await tool.run({ threadId: "thread-1" }, ctx);

    expect(dbReadCalledInTx).toBe(true);
    expect(txCalls).toContain("org1");
  });

  it("threadSummary is called outside any runInNewTenantTransaction — AI gateway call does not hold a pooled connection", async () => {
    mockedResolve.mockResolvedValue(RESOLVED);
    mockMail.listAccounts.mockResolvedValue([
      { id: 1, accountEmail: "a@b.com", isPrimary: true },
    ]);
    let threadSummaryCalledInTx = false;
    mockMailAi.threadSummary.mockImplementation(() => {
      threadSummaryCalledInTx = insideTx;
      return Promise.resolve({ summary: "done" });
    });

    const tool = findTool("summarizeMailThread");
    await tool.run({ threadId: "thread-1" }, ctx);

    expect(threadSummaryCalledInTx).toBe(false);
  });
});

describe("sendMailFromAccount — PRD-14.1: transaction boundary", () => {
  it("declares ownsTransaction so the registry does not hold a pooled connection during account resolution and proposal", () => {
    const tool = findTool("sendMailFromAccount");
    expect(tool.ownsTransaction).toBe(true);
  });

  it("resolveToolkitConnection is called inside a runInNewTenantTransaction — DB read has tenant GUC", async () => {
    let dbReadCalledInTx = false;
    mockedResolve.mockImplementation(() => {
      dbReadCalledInTx = insideTx;
      return Promise.resolve(RESOLVED);
    });
    mockMail.listAccounts.mockResolvedValue([
      { id: 1, accountEmail: "from@org.com", isPrimary: true, status: "active" },
    ]);
    mockConfirmation.propose.mockResolvedValue({
      proposalId: 1,
      token: "tok",
      expiresAt: new Date(Date.now() + 60000),
    });

    const tool = findTool("sendMailFromAccount");
    await tool.run({ toEmail: "to@x.com", subject: "Subj", body: "Body" }, ctx);

    expect(dbReadCalledInTx).toBe(true);
    expect(txCalls).toContain("org1");
  });

  it("confirmation.propose is called outside any runInNewTenantTransaction — it manages its own DB transaction", async () => {
    mockedResolve.mockResolvedValue(RESOLVED);
    mockMail.listAccounts.mockResolvedValue([
      { id: 1, accountEmail: "from@org.com", isPrimary: true, status: "active" },
    ]);
    let proposeCalledInTx = false;
    mockConfirmation.propose.mockImplementation(() => {
      proposeCalledInTx = insideTx;
      return Promise.resolve({ proposalId: 1, token: "tok", expiresAt: new Date(Date.now() + 60000) });
    });

    const tool = findTool("sendMailFromAccount");
    await tool.run({ toEmail: "to@x.com", subject: "Subj", body: "Body" }, ctx);

    expect(proposeCalledInTx).toBe(false);
  });
});
