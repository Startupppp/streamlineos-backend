import { KbLinkedDocumentQueryService, type LinkedDocumentCaller } from "./kb-linked-document-query.service";

/**
 * V-146: a refusal is an answer. Asking for entries that are not live — archived, withdrawn, source removed — used
 * to answer 403 to a reader, which says both that the archive exists and that they are not allowed near it. A
 * reader is now simply told what they can see, which is none of them, and the database is never asked.
 */
describe("linked document list, non-live statuses", () => {
  const reader: LinkedDocumentCaller = { orgId: "org-a", userId: "user-reader", canPublish: false };
  const publisher: LinkedDocumentCaller = { orgId: "org-a", userId: "user-hr", canPublish: true };

  function build() {
    // Any use of the database at all fails the spec: the reader's page is decided before a statement is built.
    const select = jest.fn(() => {
      throw new Error("the database must not be reached for a reader's non-live page");
    });
    return { service: new KbLinkedDocumentQueryService({ select } as never), select };
  }

  it.each(["unpublished", "source_removed", "all"] as const)(
    "answers a reader an empty page for status %s, without refusing and without a query",
    async (status) => {
      const { service, select } = build();

      const page = await service.list(reader, { limit: 25, status });

      expect(page.data).toEqual([]);
      expect(page.pagination).toEqual({ limit: 25, hasMore: false, nextCursor: null });
      expect(select).not.toHaveBeenCalled();
    },
  );

  it("does not swallow a publisher's request: the archive is still queried for someone who may see it", async () => {
    const { service } = build();

    // The double throws on `select`, so reaching the database is exactly what proves the early return did not fire.
    await expect(service.list(publisher, { limit: 25, status: "source_removed" })).rejects.toThrow(
      "the database must not be reached",
    );
  });
});
