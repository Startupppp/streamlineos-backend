import { KbLinkedDocumentQueryService, type LinkedDocumentCaller } from "./kb-linked-document-query.service";

describe("linked document list, non-live statuses", () => {
  const reader: LinkedDocumentCaller = { orgId: "org-a", userId: "user-reader", canPublish: false };
  const publisher: LinkedDocumentCaller = { orgId: "org-a", userId: "user-hr", canPublish: true };

  function build() {
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

    await expect(service.list(publisher, { limit: 25, status: "source_removed" })).rejects.toThrow(
      "the database must not be reached",
    );
  });
});
