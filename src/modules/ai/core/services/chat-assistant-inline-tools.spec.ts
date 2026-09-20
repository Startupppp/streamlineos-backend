import { WorkspaceInlineTools } from "./chat-assistant-inline-tools";
import type { Db } from "../../../../db/drizzle.module";
import type { AskOsToolRunContext } from "../registry/ask-os-tool.types";
import { ScopedRead } from "../../../access/scoped-read";
import type { AskOsActor } from "./ask-os-actor";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

const mockDb = {
  select: jest.fn(),
} as unknown as Db;

const mockProjectsAi = {
  ask: jest.fn(),
  summarize: jest.fn(),
};

const mockKbAsk = {
  ask: jest.fn(),
};

const mockModuleRef = {
  get: jest.fn(),
};

const actor: AskOsActor = {
  userId: "u1",
  orgId: "org1",
  membershipId: 3,
  displayName: "Bob",
  email: "bob@org.com",
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

function makeTools() {
  const instance = new WorkspaceInlineTools(
    mockDb,
    mockProjectsAi as never,
    mockModuleRef as never,
  );
  return instance.tools();
}

describe("WorkspaceInlineTools — tool metadata", () => {
  it("declares correct keys, permissions, and modules for all four tools", () => {
    const tools = makeTools();
    const byKey = Object.fromEntries(tools.map((t) => [t.key, t]));
    expect(byKey["searchProjects"]).toMatchObject({ permission: "build:view", module: "build" });
    expect(byKey["askProjectAI"]).toMatchObject({ permission: "build:ai:use", module: "build" });
    expect(byKey["getProjectSummary"]).toMatchObject({ permission: "build:ai:use", module: "build" });
    expect(byKey["searchKnowledgeBase"]).toMatchObject({ permission: "kb:articles:view", module: "kb" });
  });
});

describe("searchProjects — DB query", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns empty when no results match the query", async () => {
    const chainMock = { from: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), limit: jest.fn().mockResolvedValue([]) };
    mockDb.select = jest.fn().mockReturnValue(chainMock);

    const tool = makeTools().find((t) => t.key === "searchProjects")!;
    const result = await tool.run({ query: "nonexistent" }, ctx);
    expect(result).toMatchObject({ kind: "empty" });
  });

  it("returns data with results when projects are found", async () => {
    const rows = [{ id: 1, name: "Alpha", key: "ALPHA", status: "ACTIVE" }];
    const chainMock = { from: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), limit: jest.fn().mockResolvedValue(rows) };
    mockDb.select = jest.fn().mockReturnValue(chainMock);

    const tool = makeTools().find((t) => t.key === "searchProjects")!;
    const result = await tool.run({ query: "Alpha" }, ctx);
    expect(result).toMatchObject({ kind: "data", data: { results: rows } });
  });
});

describe("askProjectAI — delegates to ProjectsAiService", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns data wrapping the service response", async () => {
    const aiResponse = { answer: "It is blocked by dependency X." };
    mockProjectsAi.ask.mockResolvedValue(aiResponse);

    const tool = makeTools().find((t) => t.key === "askProjectAI")!;
    const result = await tool.run({ projectId: 5, question: "What is blocked?" }, ctx);
    expect(result).toMatchObject({ kind: "data", data: aiResponse });
    expect(mockProjectsAi.ask).toHaveBeenCalledWith("org1", 5, "What is blocked?", "u1");
  });

  it("returns failed when the service throws", async () => {
    mockProjectsAi.ask.mockRejectedValue(new Error("not found"));
    const tool = makeTools().find((t) => t.key === "askProjectAI")!;
    const result = await tool.run({ projectId: 99, question: "?" }, ctx);
    expect(result).toMatchObject({ kind: "failed" });
  });
});

describe("getProjectSummary — delegates to ProjectsAiService", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns data wrapping the summary response", async () => {
    const summary = { summary: "On track.", highlights: [], atRisk: false };
    mockProjectsAi.summarize.mockResolvedValue(summary);

    const tool = makeTools().find((t) => t.key === "getProjectSummary")!;
    const result = await tool.run({ projectId: 3 }, ctx);
    expect(result).toMatchObject({ kind: "data", data: summary });
    expect(mockProjectsAi.summarize).toHaveBeenCalledWith("org1", 3, "u1");
  });
});

describe("searchKnowledgeBase — uses moduleRef to reach KbAskService", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns data with answer when KbAskService resolves", async () => {
    mockModuleRef.get.mockReturnValue(mockKbAsk);
    mockKbAsk.ask.mockResolvedValue({ answer: "Our policy is X.", hasContext: true });

    const tool = makeTools().find((t) => t.key === "searchKnowledgeBase")!;
    const result = await tool.run({ query: "What is our leave policy?" }, ctx);
    expect(result).toMatchObject({ kind: "data", data: { answer: "Our policy is X.", hasContext: true } });
    expect(mockKbAsk.ask).toHaveBeenCalledWith(caller, { question: "What is our leave policy?" });
  });

  it("returns failed when KbAskService is unavailable at runtime", async () => {
    mockModuleRef.get.mockImplementation(() => { throw new Error("not found"); });
    const tool = makeTools().find((t) => t.key === "searchKnowledgeBase")!;
    const result = await tool.run({ query: "anything" }, ctx);
    expect(result).toMatchObject({ kind: "failed" });
  });
});
