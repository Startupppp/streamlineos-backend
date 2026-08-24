jest.mock("../../kb/kb-attachment-extract.util", () => ({
  extractAttachmentText: jest.fn(),
  isExtractableMime: jest.fn(),
}));

import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { AccountingAiService } from "./accounting-ai.service";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { extractAttachmentText } from "../../kb/retrieval/kb-attachment-extract.util";

const mockExtractAttachmentText = extractAttachmentText as jest.Mock;

const mockGateway = {
  invokeStructured: jest.fn(),
  invokeStructuredWithImage: jest.fn(),
  invokeText: jest.fn(),
};

const mockDb = {
  query: {
    finReconciliationMatches: { findFirst: jest.fn() },
    finBankTransactions: { findFirst: jest.fn() },
    journalEntries: { findFirst: jest.fn() },
  },
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  innerJoin: jest.fn().mockReturnThis(),
};

const SAMPLE_MATCH = {
  id: 1,
  orgId: "org-1",
  bankTransactionId: 10,
  journalEntryId: 20,
  matchedType: "CUSTOMER_PAYMENT",
  matchedRecordId: 5,
  amount: "1500.00",
  confidence: "0.95",
  isConfirmed: true,
  createdAt: new Date(),
};

const SAMPLE_BANK_TXN = {
  id: 10,
  txnDate: "2025-07-01",
  description: "ACH Payment",
  amount: "1500.00",
  counterparty: "ACME Corp",
};

const SAMPLE_JOURNAL_ENTRY = {
  id: 20,
  entryNumber: "JE-001",
  entryDate: "2025-07-01",
  description: "AR receipt",
};

const VARIANCE_NARRATION = {
  narration: "The variance was driven by...",
  factors: [{ label: "Budget", value: "$10,000", isFactual: true }],
  suggestedInvestigations: ["Review Q3 expense reports"],
};

const RECON_NARRATION = {
  narration: "The reconciliation matches a customer payment...",
  factors: [{ label: "Amount", value: "1500.00", isFactual: true }],
};

const EXTRACT_NARRATION = {
  vendor: "ACME Corp",
  documentDate: "2025-07-01",
  documentNumber: "INV-001",
  currency: "USD",
  subtotalAmount: 1400,
  taxAmount: 100,
  totalAmount: 1500,
  lineItems: [{ description: "Services", quantity: 1, unitPrice: 1400, lineTotal: 1400 }],
  paymentTerms: "Net 30",
  notes: null,
};

function makeGatewayOk<T>(data: T) {
  return {
    ok: true as const,
    data,
    model: "gpt-4o-mini",
    latencyMs: 10,
    correlationId: "corr-1",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };
}

function makeGatewayFail(kind: "provider_unavailable" | "quota_exceeded" | "not_configured" | "invalid_output") {
  return {
    ok: false as const,
    kind,
    message: "AI provider error",
    correlationId: "corr-err",
  };
}

describe("AccountingAiService", () => {
  let service: AccountingAiService;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockReturnThis();
    mockDb.innerJoin.mockReturnThis();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountingAiService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AiGatewayService, useValue: mockGateway },
      ],
    }).compile();

    service = module.get(AccountingAiService);
  });

  describe("explainVariance", () => {
    const varianceBody = {
      accountName: "Marketing Expenses",
      accountCode: "6100",
      periodLabel: "Q3 2025",
      actualAmount: 85000,
      budgetAmount: 75000,
      varianceAmount: 10000,
      variancePct: 13.33,
      priorPeriodAmount: 70000,
    };

    it("returns narration with factors when gateway succeeds and passes evidence numbers verbatim", async () => {
      mockGateway.invokeStructured.mockResolvedValue(makeGatewayOk(VARIANCE_NARRATION));

      const result = await service.explainVariance("org-1", "user-1", varianceBody);

      expect(result.narration).toBe(VARIANCE_NARRATION.narration);
      expect(result.factors).toEqual(VARIANCE_NARRATION.factors);
      expect(result.suggestedInvestigations).toEqual(VARIANCE_NARRATION.suggestedInvestigations);

      const [callArgs] = mockGateway.invokeStructured.mock.calls;
      const promptText = JSON.stringify(callArgs[0].prompt);
      expect(promptText).toContain(String(varianceBody.actualAmount));
      expect(promptText).toContain(String(varianceBody.budgetAmount));
      expect(promptText).toContain(String(varianceBody.varianceAmount));
    });

    it("throws ServiceUnavailableException when gateway returns ok=false", async () => {
      mockGateway.invokeStructured.mockResolvedValue(makeGatewayFail("provider_unavailable"));
      await expect(service.explainVariance("org-1", "user-1", varianceBody)).rejects.toThrow(ServiceUnavailableException);
    });

    it("never queries the database for explainVariance", async () => {
      mockGateway.invokeStructured.mockResolvedValue(makeGatewayOk(VARIANCE_NARRATION));
      await service.explainVariance("org-1", "user-1", varianceBody);

      expect(mockDb.query.finReconciliationMatches.findFirst).not.toHaveBeenCalled();
      expect(mockDb.query.finBankTransactions.findFirst).not.toHaveBeenCalled();
      expect(mockDb.query.journalEntries.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("explainReconciliation", () => {
    beforeEach(() => {
      mockDb.query.finReconciliationMatches.findFirst.mockResolvedValue(SAMPLE_MATCH);
      mockDb.query.finBankTransactions.findFirst.mockResolvedValue(SAMPLE_BANK_TXN);
      mockDb.query.journalEntries.findFirst.mockResolvedValue(SAMPLE_JOURNAL_ENTRY);
      mockDb.where.mockResolvedValue([{ totalDebit: "1500.00", totalCredit: "0.00" }]);
      mockGateway.invokeStructured.mockResolvedValue(makeGatewayOk(RECON_NARRATION));
    });

    it("queries DB for match by matchId and orgId, then calls gateway with evidence snapshot", async () => {
      await service.explainReconciliation("org-1", "user-1", { matchId: 1 });

      expect(mockGateway.invokeStructured).toHaveBeenCalledTimes(1);
      const [callArgs] = mockGateway.invokeStructured.mock.calls;
      const promptText = JSON.stringify(callArgs[0].prompt);
      expect(promptText).toContain("1");
    });

    it("throws NotFoundException when match is not found in DB", async () => {
      mockDb.query.finReconciliationMatches.findFirst.mockResolvedValue(undefined);

      await expect(service.explainReconciliation("org-1", "user-1", { matchId: 999 })).rejects.toThrow(NotFoundException);
      expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
    });

    it("throws NotFoundException when match.orgId does not match the caller orgId (tenant isolation)", async () => {
      mockDb.query.finReconciliationMatches.findFirst.mockResolvedValue({
        ...SAMPLE_MATCH,
        orgId: "org-other",
      });

      await expect(service.explainReconciliation("org-1", "user-1", { matchId: 1 })).rejects.toThrow(NotFoundException);
      expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
    });

    it("returns narration with evidenceSnapshot containing matchId, bankTxn fields, journalEntry fields", async () => {
      const result = await service.explainReconciliation("org-1", "user-1", { matchId: 1 });

      expect(result.narration).toBeDefined();
      expect(result.evidenceSnapshot).toBeDefined();
      expect(result.evidenceSnapshot).toMatchObject(
        expect.objectContaining({ matchId: expect.anything() }),
      );
    });
  });

  describe("extractDocument", () => {
    const pdfBody = {
      fileBase64: Buffer.from("fake pdf content").toString("base64"),
      mimeType: "application/pdf",
      sourceDocumentName: "invoice-001.pdf",
    };

    const imageBody = {
      fileBase64: Buffer.from("fake jpeg content").toString("base64"),
      mimeType: "image/jpeg",
      sourceDocumentName: "invoice-scan.jpg",
    };

    beforeEach(() => {
      mockExtractAttachmentText.mockResolvedValue("Extracted text from PDF: Invoice #001, Total: $1,500");
      mockGateway.invokeStructured.mockResolvedValue(makeGatewayOk(EXTRACT_NARRATION));
      mockGateway.invokeStructuredWithImage.mockResolvedValue(makeGatewayOk(EXTRACT_NARRATION));
    });

    it("for PDF mime type: calls extractAttachmentText then calls invokeStructured (not invokeStructuredWithImage)", async () => {
      await service.extractDocument("org-1", "user-1", pdfBody);

      expect(mockExtractAttachmentText).toHaveBeenCalled();
      expect(mockGateway.invokeStructured).toHaveBeenCalledTimes(1);
      expect(mockGateway.invokeStructuredWithImage).not.toHaveBeenCalled();
    });

    it("for image/jpeg mime type: calls invokeStructuredWithImage with the base64 string and does not call extractAttachmentText", async () => {
      await service.extractDocument("org-1", "user-1", imageBody);

      expect(mockGateway.invokeStructuredWithImage).toHaveBeenCalledTimes(1);
      expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
      expect(mockExtractAttachmentText).not.toHaveBeenCalled();
    });

    it("always returns reviewRequired: true regardless of gateway output", async () => {
      const pdfResult = await service.extractDocument("org-1", "user-1", pdfBody);
      expect(pdfResult.reviewRequired).toBe(true);

      const imageResult = await service.extractDocument("org-1", "user-1", imageBody);
      expect(imageResult.reviewRequired).toBe(true);
    });

    it("always returns a non-empty warningMessage", async () => {
      const pdfResult = await service.extractDocument("org-1", "user-1", pdfBody);
      expect(typeof pdfResult.warningMessage).toBe("string");
      expect(pdfResult.warningMessage.length).toBeGreaterThan(0);

      const imageResult = await service.extractDocument("org-1", "user-1", imageBody);
      expect(typeof imageResult.warningMessage).toBe("string");
      expect(imageResult.warningMessage.length).toBeGreaterThan(0);
    });

    it("never calls db.insert or db.update — extractDocument must not create DB records", async () => {
      const insertMock = jest.fn();
      const updateMock = jest.fn();
      (mockDb as Record<string, unknown>).insert = insertMock;
      (mockDb as Record<string, unknown>).update = updateMock;

      await service.extractDocument("org-1", "user-1", pdfBody);

      expect(insertMock).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();

      delete (mockDb as Record<string, unknown>).insert;
      delete (mockDb as Record<string, unknown>).update;
    });

    it("throws ServiceUnavailableException when gateway returns ok=false", async () => {
      mockGateway.invokeStructured.mockResolvedValue(makeGatewayFail("provider_unavailable"));
      await expect(service.extractDocument("org-1", "user-1", pdfBody)).rejects.toThrow(ServiceUnavailableException);
    });

    it("throws ServiceUnavailableException when gateway returns ok=false for image input", async () => {
      mockGateway.invokeStructuredWithImage.mockResolvedValue(makeGatewayFail("not_configured"));
      await expect(service.extractDocument("org-1", "user-1", imageBody)).rejects.toThrow(ServiceUnavailableException);
    });
  });
});
