import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  documentVersions,
  documents,
  kbLinkedDocumentAudiences,
  kbLinkedDocuments,
  orgUnits,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { metadataSearch } from "./kb-linked-document-search";
import { decodeLinkedDocumentCursor, encodeLinkedDocumentCursor } from "./kb-linked-document-cursor";
import { loadCallerAudience, publisherCanSeeRecord, visibleTo } from "./kb-linked-document-visibility";
import type { ListLinkedDocumentsQuery } from "./dto/kb-linked-documents.schemas";
import type { LinkedDocumentDetail, LinkedDocumentItem } from "./dto/kb-linked-documents-response.schemas";

export interface LinkedDocumentCaller {
  orgId: string;
  userId: string;
  /** Holds `hr:documents:publish`: sees every live entry, and the audience and version detail behind it. */
  canPublish: boolean;
}

const MAX_AUDIENCES_SHOWN = 50;

const pinned = sql`(${kbLinkedDocuments.versionMode} = 'PINNED')`;
// A pinned entry reads its file from the pinned version; a following one reads whatever the document currently is.
const fileRef = sql<string | null>`(CASE WHEN ${pinned} THEN ${documentVersions.fileUrl} ELSE ${documents.fileUrl} END)`;

const PROJECTION = {
  id: kbLinkedDocuments.id,
  name: documents.name,
  description: documents.description,
  category: documents.category,
  tags: sql<string[] | null>`${documents.tags}`,
  documentType: sql<string | null>`${documents.type}::text`,
  effectiveDate: sql<string | null>`(CASE WHEN ${pinned} THEN ${documentVersions.effectiveDate} ELSE ${documents.effectiveDate} END)::text`,
  version: sql<number | null>`(CASE WHEN ${pinned} THEN ${kbLinkedDocuments.pinnedVersion} ELSE ${documents.version} END)`,
  publishedAt: kbLinkedDocuments.publishedAt,
  // An external https link is metadata only: there is no stored file to open.
  hasFile: sql<boolean>`coalesce(${fileRef} <> '' AND ${fileRef} !~* '^https?://', false)`,
  fileName: sql<string | null>`(CASE WHEN ${pinned} THEN ${documentVersions.fileName} ELSE ${documents.fileName} END)`,
  fileSize: sql<number | null>`(CASE WHEN ${pinned} THEN ${documentVersions.fileSize} ELSE ${documents.fileSize} END)`,
  mimeType: sql<string | null>`(CASE WHEN ${pinned} THEN ${documentVersions.mimeType} ELSE ${documents.mimeType} END)`,
  status: kbLinkedDocuments.status,
  versionMode: kbLinkedDocuments.versionMode,
  pinnedVersion: kbLinkedDocuments.pinnedVersion,
  unpublishReason: kbLinkedDocuments.unpublishReason,
  newerVersionAvailable: sql<boolean>`(${pinned} AND EXISTS (
    SELECT 1 FROM ${documentVersions} AS nv
    WHERE nv.org_id = ${kbLinkedDocuments.orgId} AND nv.document_id = ${kbLinkedDocuments.documentId}
      AND nv.status = 'approved' AND nv.version > ${kbLinkedDocuments.pinnedVersion}
  ))`,
};

type Row = {
  id: number;
  name: string | null;
  description: string | null;
  category: string | null;
  tags: string[] | null;
  documentType: string | null;
  effectiveDate: string | null;
  version: number | null;
  publishedAt: Date;
  hasFile: boolean;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  status: LinkedDocumentItem["status"];
  versionMode: LinkedDocumentItem["versionMode"];
  pinnedVersion: number | null;
  unpublishReason: string | null;
  newerVersionAvailable: boolean;
};

function toItem(row: Row): LinkedDocumentItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    tags: row.tags ?? [],
    documentType: row.documentType,
    effectiveDate: row.effectiveDate,
    version: row.version,
    publishedAt: row.publishedAt,
    source: "HR_DOCUMENT",
    hasFile: row.hasFile,
    fileName: row.fileName,
    fileSize: row.fileSize,
    mimeType: row.mimeType,
    status: row.status,
    versionMode: row.versionMode,
    pinnedVersion: row.pinnedVersion,
  };
}

/**
 * The knowledge base's view of linked HR documents, for one caller. Every read is filtered IN SQL by the
 * live guard (the entry is active and its document is publishable right now) and by the caller's audience;
 * nothing is fetched and then hidden. An entry the caller may not see does not exist as far as they can tell:
 * detail and open answer 404, exactly as for an id that was never issued.
 */
@Injectable()
export class KbLinkedDocumentQueryService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  // Select, filter, order and bound in one statement, so no caller can forget the limit.
  private selectEntries(where: SQL | undefined, limit: number, order: SQL[] = [desc(kbLinkedDocuments.publishedAt), desc(kbLinkedDocuments.id)]): Promise<Row[]> {
    return this.db
      .select(PROJECTION)
      .from(kbLinkedDocuments)
      .leftJoin(documents, and(eq(documents.orgId, kbLinkedDocuments.orgId), eq(documents.id, kbLinkedDocuments.documentId)))
      .leftJoin(
        documentVersions,
        and(
          eq(documentVersions.orgId, kbLinkedDocuments.orgId),
          eq(documentVersions.documentId, kbLinkedDocuments.documentId),
          eq(documentVersions.version, kbLinkedDocuments.pinnedVersion),
          eq(documentVersions.status, "approved"),
        ),
      )
      .where(where)
      .orderBy(...order)
      .limit(limit);
  }

  private async visibility(caller: LinkedDocumentCaller): Promise<SQL> {
    const audience = caller.canPublish ? undefined : await loadCallerAudience(this.db, caller.orgId, caller.userId);
    return visibleTo(audience ?? { isEmployee: false, departmentIds: [], locationIds: [] }, caller.canPublish);
  }

  async list(caller: LinkedDocumentCaller, query: ListLinkedDocumentsQuery) {
    const status = query.status ?? "active";
    if (status !== "active" && !caller.canPublish) throw new ForbiddenException("Only publishers can list entries that are not live.");

    const search = query.q === undefined ? undefined : metadataSearch(query.q, "all");
    // Words that hold no letter or digit find nothing; they must not fall through to "everything".
    if (query.q !== undefined && !search) return { data: [], pagination: { limit: query.limit, hasMore: false, nextCursor: null } };

    const conditions: SQL[] = [eq(kbLinkedDocuments.orgId, caller.orgId)];
    if (search) conditions.push(search.match);
    if (status === "active") conditions.push(await this.visibility(caller));
    else if (status === "all") conditions.push(publisherCanSeeRecord);
    else conditions.push(eq(kbLinkedDocuments.status, status));

    if (query.cursor) {
      const cursor = decodeLinkedDocumentCursor(query.cursor);
      conditions.push(
        sql`(${kbLinkedDocuments.publishedAt} < ${cursor.publishedAt}::timestamptz OR (${kbLinkedDocuments.publishedAt} = ${cursor.publishedAt}::timestamptz AND ${kbLinkedDocuments.id} < ${cursor.id}))`,
      );
    }

    const rows = await this.selectEntries(and(...conditions), query.limit + 1);

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toItem),
      pagination: {
        limit: query.limit,
        hasMore: rows.length > query.limit,
        nextCursor: rows.length > query.limit && last ? encodeLinkedDocumentCursor({ publishedAt: last.publishedAt.toISOString(), id: last.id }) : null,
      },
    };
  }

  async get(caller: LinkedDocumentCaller, linkedDocumentId: number): Promise<LinkedDocumentDetail> {
    const [row] = await this.selectEntries(
      and(
        eq(kbLinkedDocuments.orgId, caller.orgId),
        eq(kbLinkedDocuments.id, linkedDocumentId),
        // A publisher may open the record of an entry that is no longer live; everyone else only sees a live one.
        caller.canPublish ? publisherCanSeeRecord : await this.visibility(caller),
      ),
      1,
    );
    if (!row) throw new NotFoundException();
    const item = toItem(row);
    if (!caller.canPublish) return { ...item, audiences: null, newerVersionAvailable: null, unpublishReason: null };
    return {
      ...item,
      audiences: await this.audiencesOf(caller.orgId, linkedDocumentId),
      newerVersionAvailable: row.newerVersionAvailable,
      unpublishReason: row.unpublishReason,
    };
  }

  /**
   * The live entries a question is about, best match first, for an assistant to cite. The same audience and live
   * guard as every other read, applied in SQL; the assistant is handed what the caller could already open and
   * nothing else. Metadata only: the words are matched against the document's own fields.
   */
  async searchForCaller(caller: LinkedDocumentCaller, question: string, limit: number): Promise<LinkedDocumentItem[]> {
    const search = metadataSearch(question, "any");
    if (!search) return [];
    const rows = await this.selectEntries(
      and(eq(kbLinkedDocuments.orgId, caller.orgId), await this.visibility(caller), search.match),
      limit,
      [desc(search.rank), desc(kbLinkedDocuments.id)],
    );
    return rows.map(toItem);
  }

  /** Which of these entries the caller may open right now. Used to re-check a citation before it is shown or replayed. */
  async visibleIds(caller: LinkedDocumentCaller, linkedDocumentIds: readonly number[]): Promise<Set<number>> {
    if (linkedDocumentIds.length === 0) return new Set();
    const rows = await this.selectEntries(
      and(eq(kbLinkedDocuments.orgId, caller.orgId), inArray(kbLinkedDocuments.id, [...linkedDocumentIds]), await this.visibility(caller)),
      linkedDocumentIds.length,
    );
    return new Set(rows.map((row) => row.id));
  }

  /** The file behind an entry, for `open`. Same visibility as `get`, and an entry with no stored file has nothing to open. */
  async resolveFile(caller: LinkedDocumentCaller, linkedDocumentId: number): Promise<{ fileKey: string; fileName: string }> {
    const [row] = await this.db
      .select({ fileKey: fileRef, name: documents.name, fileName: sql<string | null>`(CASE WHEN ${pinned} THEN ${documentVersions.fileName} ELSE ${documents.fileName} END)` })
      .from(kbLinkedDocuments)
      .innerJoin(documents, and(eq(documents.orgId, kbLinkedDocuments.orgId), eq(documents.id, kbLinkedDocuments.documentId)))
      .leftJoin(
        documentVersions,
        and(
          eq(documentVersions.orgId, kbLinkedDocuments.orgId),
          eq(documentVersions.documentId, kbLinkedDocuments.documentId),
          eq(documentVersions.version, kbLinkedDocuments.pinnedVersion),
          eq(documentVersions.status, "approved"),
        ),
      )
      .where(and(eq(kbLinkedDocuments.orgId, caller.orgId), eq(kbLinkedDocuments.id, linkedDocumentId), await this.visibility(caller)))
      .limit(1);
    if (!row?.fileKey || /^https?:\/\//i.test(row.fileKey)) throw new NotFoundException();
    return { fileKey: row.fileKey, fileName: row.fileName ?? row.name };
  }

  private async audiencesOf(orgId: string, linkedDocumentId: number): Promise<NonNullable<LinkedDocumentDetail["audiences"]>> {
    return this.db
      .select({ kind: kbLinkedDocumentAudiences.kind, refId: kbLinkedDocumentAudiences.refId, label: orgUnits.name })
      .from(kbLinkedDocumentAudiences)
      .leftJoin(orgUnits, and(eq(orgUnits.orgId, kbLinkedDocumentAudiences.orgId), eq(orgUnits.id, kbLinkedDocumentAudiences.refId)))
      .where(and(eq(kbLinkedDocumentAudiences.orgId, orgId), eq(kbLinkedDocumentAudiences.linkedDocumentId, linkedDocumentId)))
      .orderBy(kbLinkedDocumentAudiences.id)
      .limit(MAX_AUDIENCES_SHOWN);
  }
}
