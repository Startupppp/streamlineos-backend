import { KbResearchBriefHandler } from "./kb-research-brief.handler";
import { AiJobHandlerRegistry } from "../../ai/jobs/ai-job-handler";

const mockBuildGraph = jest.fn();
const mockRunResearchBrief = jest.fn();

jest.mock("./kb-research-brief.graph", () => ({
  buildResearchBriefGraph: (...args: unknown[]) => mockBuildGraph(...args),
  runResearchBrief: (...args: unknown[]) => mockRunResearchBrief(...args),
}));

describe("KbResearchBriefHandler — denial-of-wallet guard (BE-94)", () => {
  const updates: Array<{ set: Record<string, unknown> }> = [];
  let executeResult: unknown[] = [];

  function makeSelectChain() {
    const resolved = Promise.resolve([]);
    const chain: Record<string, unknown> = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
      then: resolved.then.bind(resolved),
      catch: resolved.catch.bind(resolved),
      finally: resolved.finally.bind(resolved),
    };
    return chain;
  }

  function makeDb() {
    return {
      execute: jest.fn().mockImplementation(() => Promise.resolve(executeResult)),
      select: jest.fn().mockImplementation(() => makeSelectChain()),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockImplementation((set: Record<string, unknown>) => ({
          where: jest.fn().mockImplementation(() => {
            updates.push({ set });
            return Promise.resolve();
          }),
        })),
      }),
      query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) } },
    };
  }

  function makeHandler(db: unknown) {
    return new KbResearchBriefHandler(
      db as never,
      {} as never,
      {} as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      new AiJobHandlerRegistry(),
    );
  }

  beforeEach(() => {
    updates.length = 0;
    executeResult = [];
    mockBuildGraph.mockReset();
    mockRunResearchBrief.mockReset();
  });

  it("short-circuits before the graph runs when the org has no indexed content — no embedding, no paid AI call fires", async () => {
    executeResult = [];
    const db = makeDb();
    const handler = makeHandler(db);

    const result = await handler.handle({
      id: 1,
      orgId: "org1",
      userId: "user1",
      payload: { briefId: 5, topic: "onboarding" },
    });

    expect(result).toEqual({ briefId: 5, status: "failed" });
    expect(mockBuildGraph).not.toHaveBeenCalled();
    expect(mockRunResearchBrief).not.toHaveBeenCalled();
    const terminal = updates.find((u) => u.set["status"] === "failed");
    expect(terminal).toBeDefined();
    expect(String(terminal?.set["errorMessage"])).toMatch(/no indexed content/i);
  });

  it("proceeds to the graph and completes when the org has indexed content (positive pair)", async () => {
    executeResult = [{ one: 1 }];
    mockRunResearchBrief.mockResolvedValue({ report: "Report text", citations: [] });
    const db = makeDb();
    const handler = makeHandler(db);

    const result = await handler.handle({
      id: 1,
      orgId: "org1",
      userId: "user1",
      payload: { briefId: 5, topic: "onboarding" },
    });

    expect(mockBuildGraph).toHaveBeenCalled();
    expect(mockRunResearchBrief).toHaveBeenCalled();
    expect(result).toEqual({ briefId: 5, status: "completed" });
    const terminal = updates.find((u) => u.set["status"] === "completed");
    expect(terminal).toBeDefined();
  });

  it("AV-04: completed brief update carries provider and model read from aggregated kb_ai_interactions rows", async () => {
    executeResult = [{ one: 1 }];
    mockRunResearchBrief.mockResolvedValue({ report: "Brief", citations: [] });

    let selectCallCount = 0;
    const customDb = {
      execute: jest.fn().mockImplementation(() => Promise.resolve(executeResult)),
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          const p = Promise.resolve([{ totalCredits: "5" }]);
          return {
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue([{ totalCredits: "5" }]),
            then: p.then.bind(p),
            catch: p.catch.bind(p),
            finally: p.finally.bind(p),
          };
        }
        const p = Promise.resolve([{ provider: "openai", model: "gpt-4o" }]);
        return {
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue([{ provider: "openai", model: "gpt-4o" }]),
          then: p.then.bind(p),
          catch: p.catch.bind(p),
          finally: p.finally.bind(p),
        };
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockImplementation((set: Record<string, unknown>) => ({
          where: jest.fn().mockImplementation(() => {
            updates.push({ set });
            return Promise.resolve();
          }),
        })),
      }),
      query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) } },
    };

    const handler = makeHandler(customDb);
    await handler.handle({
      id: 1,
      orgId: "org1",
      userId: "user1",
      payload: { briefId: 5, topic: "onboarding" },
    });

    const completedUpdate = updates.find((u) => u.set["status"] === "completed");
    expect(completedUpdate).toBeDefined();
    expect(completedUpdate?.set["provider"]).toBe("openai");
    expect(completedUpdate?.set["model"]).toBe("gpt-4o");
  });
});
