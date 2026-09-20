import { NotFoundException } from "@nestjs/common";
import { SupportAiTriageAnalysisService } from "./support-ai-triage-analysis.service";
import { SupportAiTriageService } from "./support-ai-triage.service";
import { withDelegatingTransaction } from "../../../test/delegating-transaction";
import { primeRelocationTrafficTracker } from "../../../common/relocation/relocation-traffic-tracker";

const TICKET = { id: 1, orgId: "aaaaaaaa-0000-0000-0000-000000000001", title: "T", description: null, status: "open", priority: "low", category: null };
const OWN_ORG = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER_ORG = "bbbbbbbb-0000-0000-0000-000000000002";
const USER = { orgId: OWN_ORG, userId: "user-1", membershipId: 1 };

function makeData(ticket: unknown) {
  return {
    getTicketOrThrow: jest.fn().mockImplementation((_orgId: string, _ticketId: number) => {
      if (!ticket) throw new NotFoundException("Ticket not found");
      return Promise.resolve(ticket);
    }),
    isEmbeddingsConfigured: jest.fn().mockReturnValue(false),
    isAvailable: jest.fn().mockResolvedValue(false),
    searchKbForTicket: jest.fn().mockResolvedValue([]),
    replacePendingSuggestions: jest.fn().mockResolvedValue(undefined),
    insertSuggestion: jest.fn().mockResolvedValue({}),
    getTicketConfidence: jest.fn().mockResolvedValue(0.9),
  };
}

function makeAnalysisData(ticket: unknown) {
  return {
    getTicketOrThrow: jest.fn().mockImplementation((_orgId: string, _ticketId: number) => {
      if (!ticket) throw new NotFoundException("Ticket not found");
      return Promise.resolve(ticket);
    }),
    isAvailable: jest.fn().mockResolvedValue(false),
    replacePendingSuggestions: jest.fn().mockResolvedValue(undefined),
    insertSuggestion: jest.fn().mockResolvedValue({}),
  };
}

describe("SupportAiTriageService.suggestKbArticles — ticket scope", () => {
  beforeEach(() => primeRelocationTrafficTracker([], Date.now()));

  it("short-circuits after ticket check on success (own → non-throwing)", async () => {
    const data = makeData(TICKET);
    const db = withDelegatingTransaction({});
    const svc = new SupportAiTriageService(db as never, data as never, {} as never, {} as never);
    const result = await svc.suggestKbArticles(USER as never, 1);
    expect(result).toBeNull();
    expect(data.getTicketOrThrow).toHaveBeenCalledWith(OWN_ORG, 1);
  });

  it("throws 404 before embedding check for a foreign ticket (cross-tenant → 404)", async () => {
    const data = makeData(undefined);
    const db = withDelegatingTransaction({});
    const svc = new SupportAiTriageService(db as never, data as never, {} as never, {} as never);
    await expect(svc.suggestKbArticles({ ...USER, orgId: OTHER_ORG } as never, 1)).rejects.toBeInstanceOf(NotFoundException);
    expect(data.isEmbeddingsConfigured).not.toHaveBeenCalled();
  });

  it("throws 404 for an unknown ticket id (unknown → 404)", async () => {
    const data = makeData(undefined);
    const db = withDelegatingTransaction({});
    const svc = new SupportAiTriageService(db as never, data as never, {} as never, {} as never);
    await expect(svc.suggestKbArticles(USER as never, 99999)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("SupportAiTriageAnalysisService.findDuplicates — ticket scope", () => {
  beforeEach(() => primeRelocationTrafficTracker([], Date.now()));

  it("short-circuits after ticket check on success (own → non-throwing)", async () => {
    const data = makeAnalysisData(TICKET);
    const aiGateway = { isEmbeddingConfigured: jest.fn().mockReturnValue(false) };
    const db = withDelegatingTransaction({});
    const svc = new SupportAiTriageAnalysisService(db as never, data as never, aiGateway as never, {} as never, {} as never);
    const result = await svc.findDuplicates(OWN_ORG, 1);
    expect(result).toBeNull();
    expect(data.getTicketOrThrow).toHaveBeenCalledWith(OWN_ORG, 1);
  });

  it("throws 404 before embedding check for a foreign ticket (cross-tenant → 404)", async () => {
    const data = makeAnalysisData(undefined);
    const aiGateway = { isEmbeddingConfigured: jest.fn().mockReturnValue(false) };
    const db = withDelegatingTransaction({});
    const svc = new SupportAiTriageAnalysisService(db as never, data as never, aiGateway as never, {} as never, {} as never);
    await expect(svc.findDuplicates(OTHER_ORG, 1)).rejects.toBeInstanceOf(NotFoundException);
    expect(aiGateway.isEmbeddingConfigured).not.toHaveBeenCalled();
  });

  it("throws 404 for an unknown ticket id (unknown → 404)", async () => {
    const data = makeAnalysisData(undefined);
    const aiGateway = { isEmbeddingConfigured: jest.fn().mockReturnValue(false) };
    const db = withDelegatingTransaction({});
    const svc = new SupportAiTriageAnalysisService(db as never, data as never, aiGateway as never, {} as never, {} as never);
    await expect(svc.findDuplicates(OWN_ORG, 99999)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("SupportAiTriageAnalysisService.findRootCauseCluster — ticket scope", () => {
  beforeEach(() => primeRelocationTrafficTracker([], Date.now()));

  it("short-circuits after ticket check on success (own → non-throwing)", async () => {
    const data = makeAnalysisData(TICKET);
    const aiGateway = { isEmbeddingConfigured: jest.fn().mockReturnValue(false) };
    const db = withDelegatingTransaction({});
    const svc = new SupportAiTriageAnalysisService(db as never, data as never, aiGateway as never, {} as never, {} as never);
    const result = await svc.findRootCauseCluster(OWN_ORG, 1);
    expect(result).toBeNull();
    expect(data.getTicketOrThrow).toHaveBeenCalledWith(OWN_ORG, 1);
  });

  it("throws 404 before embedding check for a foreign ticket (cross-tenant → 404)", async () => {
    const data = makeAnalysisData(undefined);
    const aiGateway = { isEmbeddingConfigured: jest.fn().mockReturnValue(false) };
    const db = withDelegatingTransaction({});
    const svc = new SupportAiTriageAnalysisService(db as never, data as never, aiGateway as never, {} as never, {} as never);
    await expect(svc.findRootCauseCluster(OTHER_ORG, 1)).rejects.toBeInstanceOf(NotFoundException);
    expect(aiGateway.isEmbeddingConfigured).not.toHaveBeenCalled();
  });

  it("throws 404 for an unknown ticket id (unknown → 404)", async () => {
    const data = makeAnalysisData(undefined);
    const aiGateway = { isEmbeddingConfigured: jest.fn().mockReturnValue(false) };
    const db = withDelegatingTransaction({});
    const svc = new SupportAiTriageAnalysisService(db as never, data as never, aiGateway as never, {} as never, {} as never);
    await expect(svc.findRootCauseCluster(OWN_ORG, 99999)).rejects.toBeInstanceOf(NotFoundException);
  });
});
