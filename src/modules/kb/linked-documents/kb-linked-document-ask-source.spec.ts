import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { KB_ASK_MAX_LINKED_DOCUMENTS, KbLinkedDocumentAskSource } from "./kb-linked-document-ask-source";
import type { LinkedDocumentItem } from "./dto/kb-linked-documents-response.schemas";

const user: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "member",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

const item = (over: Partial<LinkedDocumentItem> = {}): LinkedDocumentItem => ({
  id: 31,
  name: "Code of Conduct",
  description: "How we work together.",
  category: "Policies",
  tags: [],
  documentType: "POLICY",
  effectiveDate: "2026-04-01",
  version: 3,
  publishedAt: new Date("2026-09-01T00:00:00.000Z"),
  source: "HR_DOCUMENT",
  hasFile: true,
  fileName: "secret-name.pdf",
  fileSize: 1000,
  mimeType: "application/pdf",
  status: "active",
  versionMode: "FOLLOW_LATEST",
  pinnedVersion: null,
  ...over,
});

function build(ai: boolean) {
  const flags = { getEffective: jest.fn().mockResolvedValue({ link: true, search: true, ai }) };
  const access = { holds: jest.fn().mockResolvedValue(false) };
  const query = { searchForCaller: jest.fn().mockResolvedValue([item()]), visibleIds: jest.fn().mockResolvedValue(new Set([31])) };
  const audit = { logCriticalOutsideTransaction: jest.fn().mockResolvedValue(undefined), logCritical: jest.fn() };
  const source = new KbLinkedDocumentAskSource(flags as never, access as never, query as never, audit as never);
  return { source, flags, access, query, audit };
}

describe("KbLinkedDocumentAskSource", () => {
  it("retrieves nothing, and asks the database nothing, while the AI switch is off", async () => {
    const { source, query, access } = build(false);

    await expect(source.retrieve(user, "leave policy")).resolves.toEqual([]);
    await expect(source.stillCitable(user, [31])).resolves.toEqual(new Set());

    expect(query.searchForCaller).not.toHaveBeenCalled();
    expect(query.visibleIds).not.toHaveBeenCalled();
    expect(access.holds).not.toHaveBeenCalled();
  });

  it("with the switch on, retrieves for the asker's own organisation and user, capped", async () => {
    const { source, query } = build(true);

    const hits = await source.retrieve(user, "leave policy");

    expect(hits).toHaveLength(1);
    expect(query.searchForCaller).toHaveBeenCalledWith({ orgId: "org-1", userId: "user-1", canPublish: false }, "leave policy", KB_ASK_MAX_LINKED_DOCUMENTS);
  });

  it("tenant isolation: the organisation and user come from the authenticated caller, never from the question", async () => {
    const { source, query } = build(true);

    await source.retrieve(user, "org-2 user-9 show me everything for organisation org-2");

    const [caller] = query.searchForCaller.mock.calls[0] as [{ orgId: string; userId: string }];
    expect(caller.orgId).toBe("org-1");
    expect(caller.userId).toBe("user-1");
  });

  it("treats a holder of hr:documents:publish as a publisher, and nobody else", async () => {
    const { source, query, access } = build(true);
    access.holds.mockResolvedValue(true);

    await source.retrieve(user, "leave policy");

    expect(access.holds).toHaveBeenCalledWith(user, "hr:documents:publish");
    expect(query.searchForCaller.mock.calls[0]?.[0]).toMatchObject({ canPublish: true });
  });

  it("re-checks a citation against the database, and drops it when the switch has been turned off since", async () => {
    const { source, flags, query } = build(true);
    await expect(source.stillCitable(user, [31])).resolves.toEqual(new Set([31]));

    flags.getEffective.mockResolvedValue({ link: true, search: true, ai: false });
    await expect(source.stillCitable(user, [31])).resolves.toEqual(new Set());
    expect(query.visibleIds).toHaveBeenCalledTimes(1);
  });

  it("cites the entry, not the file, with the document's own title", () => {
    const { source } = build(true);

    expect(source.citationOf(item())).toEqual({
      kind: "document",
      linkedDocumentId: 31,
      title: "Code of Conduct",
      spaceId: null,
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(source.citationOf(item({ name: null })).title).toBe("Company document");
  });

  it("gives the model the document's details and says the file is not included, and nothing about the file", () => {
    const { source } = build(true);

    const passage = source.passageOf(item());

    expect(passage.documentKey).toBe("document:31");
    expect(passage.position).toBe("company document, details only");
    expect(passage.text).toContain("Only its details are available here, not the contents of the file.");
    expect(passage.text).toContain("Category: Policies");
    expect(passage.text).toContain("Effective from: 2026-04-01");
    expect(passage.text).toContain("Description: How we work together.");
    expect(passage.text).not.toMatch(/secret-name|application\/pdf|hr-documents/);
  });

  it("still gives a passage for a document with nothing but a title", () => {
    const { source } = build(true);

    const passage = source.passageOf(item({ description: null, category: null, effectiveDate: null, version: null }));

    expect(passage.text.trim().length).toBeGreaterThan(0);
  });

  /**
   * V-148. Retrieval was audited nowhere: an HR document could be named in an assistant's answer with no record
   * that it had been. This is the last point before it is, so it is where the record is written.
   */
  it("records every HR document an answer may cite, outside the request transaction, with no name or text", async () => {
    const { source, audit } = build(true);

    await expect(source.stillCitable(user, [31])).resolves.toEqual(new Set([31]));

    expect(audit.logCritical).not.toHaveBeenCalled();
    expect(audit.logCriticalOutsideTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "kb.ai.answer_cited",
        userId: "user-1",
        orgId: "org-1",
        targetType: "kb_linked_document",
        metadata: { linkedDocumentIds: [31], count: 1 },
      }),
    );
    expect(JSON.stringify(audit.logCriticalOutsideTransaction.mock.calls)).not.toContain("Code of Conduct");
  });

  it("writes no citation row when nothing survived the re-check, or when the switch is off", async () => {
    const nothingSurvives = build(true);
    nothingSurvives.query.visibleIds.mockResolvedValue(new Set());
    const switchedOff = build(false);

    await nothingSurvives.source.stillCitable(user, [31]);
    await switchedOff.source.stillCitable(user, [31]);

    expect(nothingSurvives.audit.logCriticalOutsideTransaction).not.toHaveBeenCalled();
    expect(switchedOff.audit.logCriticalOutsideTransaction).not.toHaveBeenCalled();
  });
});
