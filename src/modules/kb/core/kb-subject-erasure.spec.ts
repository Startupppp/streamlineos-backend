import { PgDialect } from "drizzle-orm/pg-core";
import {
  eraseSubjectDocumentDerivatives,
  subjectAuthoredDocument,
  type DocumentReindexPort,
} from "./kb-subject-erasure";
import { kbArticleChunks, kbPages } from "../../../db/schema";

const ORG = "org-erasure";
const SUBJECT = "user-erasure-subject";
const MEMBERSHIP = 42;

interface DrainedDocument {
  id: number;
  contentRevision: number;
  aclRevision: number;
  contentText: string | null;
}

function makeTx(opts: {
  documents?: DrainedDocument[];
  chunksDeleted?: number;
}) {
  const { documents = [], chunksDeleted = 0 } = opts;
  const deletedTables: unknown[] = [];

  const selectChain = (rows: unknown[]) => ({
    from: () => selectChain(rows),
    where: () => selectChain(rows),
    orderBy: () => selectChain(rows),
    limit: () => Promise.resolve(rows),
  });

  let selectCall = 0;

  return {
    deletedTables,
    tx: {
      select: () => ({
        from: (table: unknown) => {
          selectCall++;
          return selectChain(
            table === kbPages && selectCall === 1 ? documents : [],
          ).from();
        },
      }),
      delete: (table: unknown) => {
        deletedTables.push(table);
        return {
          where: () => ({
            returning: () =>
              Promise.resolve(
                table === kbArticleChunks
                  ? Array.from({ length: chunksDeleted }, (_, i) => ({ id: i }))
                  : [],
              ),
          }),
        };
      },
    } as never,
  };
}

function makeWriter(): DocumentReindexPort & {
  commitManyPageChanges: jest.Mock;
} {
  return { commitManyPageChanges: jest.fn().mockResolvedValue(undefined) };
}

describe("subjectAuthoredDocument — which Documents erasure reaches", () => {
  const rendered = new PgDialect().sqlToQuery(
    subjectAuthoredDocument(SUBJECT, MEMBERSHIP),
  ).sql;

  it.each([
    "created_by_id",
    "owner_user_id",
    "last_edited_by_id",
    "created_by_membership_id",
    "owner_membership_id",
    "last_edited_by_membership_id",
  ])(
    "names %s, so an authorship column added to kb_pages cannot silently escape erasure",
    (column) => {
      expect(rendered).toContain(column);
    },
  );

  it("does not name deleted_by_id, because archiving another person's Document does not make its text the subject's data", () => {
    expect(rendered).not.toContain("deleted_by_id");
  });

  it("survives the move out of gdpr unchanged, so the rule now has exactly one home inside the Documents module", () => {
    expect(rendered).toContain("or");
    expect(rendered.match(/=/g)?.length).toBe(6);
  });
});

describe("eraseSubjectDocumentDerivatives — the Document does not go dark", () => {
  it("emits an Index event for every Document whose Chunks it deleted, because the body survives erasure and an un-indexed Document is unreachable by Retrieve until something unrelated rewrites it", async () => {
    const documents: DrainedDocument[] = [
      { id: 7, contentRevision: 3, aclRevision: 2, contentText: "surviving body" },
    ];
    const { tx } = makeTx({ documents, chunksDeleted: 4 });
    const writer = makeWriter();

    await eraseSubjectDocumentDerivatives(
      tx,
      { orgId: ORG, subjectUserId: SUBJECT, membershipId: MEMBERSHIP },
      writer,
    );

    expect(writer.commitManyPageChanges).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ orgId: ORG, pages: documents }),
    );
  });

  it("carries the post-erasure revisions into the Index event, so the consumer re-embeds the Document at the version that actually survived", async () => {
    const { tx } = makeTx({
      documents: [
        { id: 7, contentRevision: 9, aclRevision: 5, contentText: "body" },
      ],
      chunksDeleted: 1,
    });
    const writer = makeWriter();

    await eraseSubjectDocumentDerivatives(
      tx,
      { orgId: ORG, subjectUserId: SUBJECT, membershipId: MEMBERSHIP },
      writer,
    );

    const pages = writer.commitManyPageChanges.mock.calls[0]?.[1]?.pages ?? [];
    expect(pages[0]).toMatchObject({ contentRevision: 9, aclRevision: 5 });
  });

  it("emits no Index event when the subject authored no Document, so an erasure with no KB footprint does not wake the indexing consumer", async () => {
    const { tx } = makeTx({ documents: [] });
    const writer = makeWriter();

    await eraseSubjectDocumentDerivatives(
      tx,
      { orgId: ORG, subjectUserId: SUBJECT, membershipId: MEMBERSHIP },
      writer,
    );

    expect(writer.commitManyPageChanges).not.toHaveBeenCalled();
  });

  it("reports kb_article_chunks only when a Chunk was actually removed, so the erasure receipt names what it touched", async () => {
    const withChunks = makeTx({
      documents: [
        { id: 7, contentRevision: 1, aclRevision: 1, contentText: "body" },
      ],
      chunksDeleted: 2,
    });
    const withoutChunks = makeTx({ documents: [] });

    const touched = await eraseSubjectDocumentDerivatives(
      withChunks.tx,
      { orgId: ORG, subjectUserId: SUBJECT, membershipId: MEMBERSHIP },
      makeWriter(),
    );
    const untouched = await eraseSubjectDocumentDerivatives(
      withoutChunks.tx,
      { orgId: ORG, subjectUserId: SUBJECT, membershipId: MEMBERSHIP },
      makeWriter(),
    );

    expect(touched).toContain("kb_article_chunks");
    expect(untouched).not.toContain("kb_article_chunks");
  });
});
