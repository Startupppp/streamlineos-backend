import { SupportAiTriageService } from "./support-ai-triage.service";
import { withDelegatingTransaction } from "../../../test/delegating-transaction";
import { primeRelocationTrafficTracker } from "../../../common/relocation/relocation-traffic-tracker";

const makeGateway = () => ({
  invokeStructured: jest.fn(),
  invokeText: jest.fn(),
});
const makeAiSettings = () => ({ getSettings: jest.fn().mockResolvedValue({ confidenceThreshold: 0.7 }) });

describe("SupportAiTriageService.suggestKbArticles — KB filter", () => {
  beforeEach(() => primeRelocationTrafficTracker([], Date.now()));

  it("returns null when no articles meet similarity threshold", async () => {
    const db = withDelegatingTransaction({});
    const mockData = {
      isEmbeddingsConfigured: jest.fn().mockReturnValue(true),
      isAvailable: jest.fn().mockResolvedValue(true),
      getTicketOrThrow: jest.fn().mockResolvedValue({ id: 1, orgId: "org-1", title: "bug", description: null }),
      searchKbForTicket: jest.fn().mockResolvedValue([]),
      replacePendingSuggestions: jest.fn().mockResolvedValue(undefined),
      insertSuggestion: jest.fn().mockResolvedValue({ id: 1 }),
      getTicketConfidence: jest.fn().mockResolvedValue(1.0),
    };

    const svc = new SupportAiTriageService(
      db as never,
      mockData as never,
      makeGateway() as never,
      makeAiSettings() as never,
    );

    const result = await svc.suggestKbArticles({ orgId: "org-1" } as never, 1);
    expect(result).toBeNull();
  });

  it("calls data.searchKbForTicket with ticket content", async () => {
    const db = withDelegatingTransaction({});
    const mockData = {
      isEmbeddingsConfigured: jest.fn().mockReturnValue(true),
      isAvailable: jest.fn().mockResolvedValue(true),
      getTicketOrThrow: jest.fn().mockResolvedValue({ id: 1, orgId: "org-1", title: "bug", description: "crash" }),
      searchKbForTicket: jest.fn().mockResolvedValue([]),
      replacePendingSuggestions: jest.fn().mockResolvedValue(undefined),
      insertSuggestion: jest.fn().mockResolvedValue({ id: 1 }),
      getTicketConfidence: jest.fn().mockResolvedValue(1.0),
    };

    const svc = new SupportAiTriageService(
      db as never,
      mockData as never,
      makeGateway() as never,
      makeAiSettings() as never,
    );

    await svc.suggestKbArticles({ orgId: "org-1" } as never, 1);

    expect(mockData.searchKbForTicket).toHaveBeenCalledTimes(1);
  });

  it("returns null when embedding service is not configured", async () => {
    const db = withDelegatingTransaction({});
    const mockData = {
      isEmbeddingsConfigured: jest.fn().mockReturnValue(false),
      isAvailable: jest.fn().mockResolvedValue(true),
      getTicketOrThrow: jest.fn(),
      searchKbForTicket: jest.fn(),
      replacePendingSuggestions: jest.fn(),
      insertSuggestion: jest.fn(),
      getTicketConfidence: jest.fn(),
    };

    const svc = new SupportAiTriageService(
      db as never,
      mockData as never,
      makeGateway() as never,
      makeAiSettings() as never,
    );

    const result = await svc.suggestKbArticles({ orgId: "org-1" } as never, 1);
    expect(result).toBeNull();
    expect(mockData.searchKbForTicket).not.toHaveBeenCalled();
  });
});
