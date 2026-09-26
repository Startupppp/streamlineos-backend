import { NotFoundException } from "@nestjs/common";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbLinkedDocumentAskSource } from "../linked-documents/kb-linked-document-ask-source";
import type { LinkedDocumentItem } from "../linked-documents/dto/kb-linked-documents-response.schemas";
import { KbAskService, type AskCitation } from "./kb-ask.service";

const user: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "member",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};
const input = { question: "How many days of leave do I get?" };
const ON = { companyDocuments: true };

const article = { kind: "article" as const, id: 1, title: "Getting started", slug: "getting-started", spaceId: 1, contentText: "Article body", updatedAt: new Date("2026-01-01") };

const document = (over: Partial<LinkedDocumentItem> = {}): LinkedDocumentItem => ({
  id: 31,
  name: "Leave Policy",
  description: "Twenty days of annual leave.",
  category: "Policies",
  tags: [],
  documentType: "POLICY",
  effectiveDate: "2026-04-01",
  version: 2,
  publishedAt: new Date("2026-09-01T00:00:00.000Z"),
  source: "HR_DOCUMENT",
  hasFile: true,
  fileName: "leave.pdf",
  fileSize: 100,
  mimeType: "application/pdf",
  status: "active",
  versionMode: "FOLLOW_LATEST",
  pinnedVersion: null,
  ...over,
});

function build(opts: { ai: boolean; hasChunks?: boolean; hits?: LinkedDocumentItem[]; visible?: number[] }) {
  const insertedRows: Record<string, unknown>[] = [];
  const db = {
    execute: jest.fn().mockResolvedValue(opts.hasChunks === false ? [] : [{ one: 1 }]),
    transaction: jest.fn(),
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation((row: Record<string, unknown>) => {
        insertedRows.push(row);
        return Promise.resolve([]);
      }),
    })),
  };
  db.transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  const gateway = {
    invokeTextWithUsage: jest.fn().mockResolvedValue({ ok: true, data: "You get twenty days.", aiUsage: { model: "m", promptTokens: 1, completionTokens: 1, totalTokens: 2, credits: 0, costUsd: 0 } }),
    streamTextWithUsage: jest.fn().mockResolvedValue({}),
  };
  const events = { record: jest.fn().mockResolvedValue(undefined) };
  const search = {
    resolveQueryEmbedding: jest.fn().mockResolvedValue({ vectorLiteral: null }),
    retrieveTopArticles: jest.fn().mockResolvedValue([article]),
    retrieveTopSources: jest.fn().mockResolvedValue([]),
    retrieveDocumentPassages: jest.fn().mockResolvedValue([]),
    aclCacheOutcome: jest.fn().mockResolvedValue("bypass"),
  };
  const citationVisibility = {
    visibleArticles: jest.fn(async (_u: unknown, ids: number[]) => new Set(ids)),
    visiblePages: jest.fn(async (_u: unknown, ids: number[]) => new Set(ids)),
    visibleSources: jest.fn(async (_u: unknown, ids: number[]) => new Set(ids)),
  };
  const flags = { getEffective: jest.fn().mockResolvedValue({ link: true, search: true, ai: opts.ai }) };
  const access = { holds: jest.fn().mockResolvedValue(false) };
  const query = {
    searchForCaller: jest.fn().mockResolvedValue(opts.hits ?? [document()]),
    visibleIds: jest.fn().mockResolvedValue(new Set(opts.visible ?? [31])),
  };
  const source = new KbLinkedDocumentAskSource(flags as never, access as never, query as never, { logCriticalOutsideTransaction: jest.fn().mockResolvedValue(undefined) } as never);
  const service = new KbAskService(db as never, gateway as never, events as never, search as never, citationVisibility as never, source, null);
  return { service, gateway, events, search, flags, query, db, insertedRows };
}

const prompt = (gateway: { invokeTextWithUsage: jest.Mock }): string => String(gateway.invokeTextWithUsage.mock.calls[0]?.[0]?.prompt?.user ?? "");
const documentCitations = (citations: AskCitation[]) => citations.filter((citation) => citation.kind === "document");

describe("KbAskService — company documents from HR", () => {
  describe("while the AI switch is off", () => {
    it("never asks for a company document, never puts one in the prompt and never cites one", async () => {
      const { service, gateway, query } = build({ ai: false });

      const result = await service.ask(user, input, ON);

      expect(query.searchForCaller).not.toHaveBeenCalled();
      expect(prompt(gateway)).not.toContain("Leave Policy");
      expect(documentCitations(result.citations)).toEqual([]);
      expect(result.citations.some((citation) => citation.kind === "article")).toBe(true);
    });

    it("still answers no-context, without embedding, for an organisation with nothing indexed", async () => {
      const { service, gateway, search } = build({ ai: false, hasChunks: false });

      const result = await service.ask(user, input, ON);

      expect(result.hasContext).toBe(false);
      expect(search.retrieveTopArticles).not.toHaveBeenCalled();
      expect(gateway.invokeTextWithUsage).not.toHaveBeenCalled();
    });
  });

  describe("for a caller that did not ask for company documents", () => {
    it("never retrieves or cites one, even with the tenant's switch on, so a surface not built to show one never receives one", async () => {
      const { service, gateway, query } = build({ ai: true });

      const result = await service.ask(user, input);

      expect(query.searchForCaller).not.toHaveBeenCalled();
      expect(prompt(gateway)).not.toContain("Leave Policy");
      expect(documentCitations(result.citations)).toEqual([]);
      expect(result.citations.some((citation) => citation.kind === "article")).toBe(true);
    });
  });

  describe("with the AI switch on", () => {
    it("puts the document's details in the prompt, labelled as details only, and cites the entry", async () => {
      const { service, gateway } = build({ ai: true });

      const result = await service.ask(user, input, ON);

      expect(documentCitations(result.citations)).toEqual([
        { kind: "document", linkedDocumentId: 31, title: "Leave Policy", spaceId: null, updatedAt: new Date("2026-09-01T00:00:00.000Z") },
      ]);
      const sent = prompt(gateway);
      expect(sent).toContain("Leave Policy | company document, details only");
      expect(sent).toContain("Description: Twenty days of annual leave.");
      expect(sent).toContain("Article body");
      expect(sent).not.toMatch(/leave\.pdf|application\/pdf|hr-documents/);
    });

    it("answers from company documents alone for an organisation with no indexed pages, without an embedding call", async () => {
      const { service, gateway, search } = build({ ai: true, hasChunks: false });

      const result = await service.ask(user, input, ON);

      expect(result.hasContext).toBe(true);
      expect(search.retrieveTopArticles).not.toHaveBeenCalled();
      expect(search.retrieveTopSources).not.toHaveBeenCalled();
      expect(search.retrieveDocumentPassages).not.toHaveBeenCalled();
      expect(documentCitations(result.citations)).toHaveLength(1);
      expect(prompt(gateway)).toContain("Leave Policy");
    });

    it("says there is nothing to go on when the asker may open no company document and the pages have nothing", async () => {
      const { service, gateway } = build({ ai: true, hasChunks: false, hits: [] });

      const result = await service.ask(user, input, ON);

      expect(result.hasContext).toBe(false);
      expect(gateway.invokeTextWithUsage).not.toHaveBeenCalled();
    });

    it("records the document among the sources of the answer", async () => {
      const { service, events, insertedRows } = build({ ai: true });

      await service.ask(user, input, ON);

      const recorded = events.record.mock.calls.find(([, name]) => name === "ai_answer");
      expect(recorded?.[2]).toMatchObject({ metadata: { sourceIds: ["article:1", "document:31"] } });
      expect(insertedRows.some((r) => r["resultState"] === "answered")).toBe(true);
    });
  });

  describe("citations are re-checked before they are shown or replayed", () => {
    it("drops a document withdrawn while the answer streamed, and keeps the page citation", async () => {
      const { service, query } = build({ ai: true });
      const started = await service.streamAsk(user, input, new AbortController().signal, ON);
      if (!started.hasContext) throw new Error("expected context");
      expect(started.citations.some((citation) => citation.kind === "document")).toBe(true);

      query.visibleIds.mockResolvedValue(new Set());
      const verified = await started.verifyCitations();

      expect(documentCitations(verified)).toEqual([]);
      expect(verified.some((citation) => citation.kind === "article")).toBe(true);
    });

    it("drops a document when the switch was turned off while the answer streamed", async () => {
      const { service, flags } = build({ ai: true });
      const started = await service.streamAsk(user, input, new AbortController().signal, ON);
      if (!started.hasContext) throw new Error("expected context");

      flags.getEffective.mockResolvedValue({ link: true, search: true, ai: false });

      expect(documentCitations(await started.verifyCitations())).toEqual([]);
    });

    it("refuses to replay a saved answer whose document the asker can no longer open", async () => {
      const { service, query } = build({ ai: true });
      const cited: AskCitation[] = [{ kind: "document", linkedDocumentId: 31, title: "Leave Policy", spaceId: null, updatedAt: new Date() }];

      await expect(service.assertReplayCitations(user, cited)).resolves.toBeUndefined();

      query.visibleIds.mockResolvedValue(new Set());
      await expect(service.assertReplayCitations(user, cited)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("refuses to replay a saved answer citing a document once the switch is off", async () => {
      const { service } = build({ ai: false });
      const cited: AskCitation[] = [{ kind: "document", linkedDocumentId: 31, title: "Leave Policy", spaceId: null, updatedAt: new Date() }];

      await expect(service.assertReplayCitations(user, cited)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
