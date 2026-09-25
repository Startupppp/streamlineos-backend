import { DocumentsService } from "./documents.service";
import { ScopedRead } from "../../access/scoped-read";
import { documentListSelection } from "./documents-helpers";

const ORG_ID = "org-no-url";
const ACTOR = "user-hr";

/**
 * V-091. `documentListSelection` exposes `hasFile` and never `fileUrl`, which is right — but it is right by
 * one line. Adding a column to that projection, or dropping the projection from a `.returning()`, would ship the
 * raw R2 URL to every viewer with nothing going red. Opening a document goes through `GET /documents/:id/file`,
 * which mints a short-lived signed URL against a validated key; a URL in a LIST payload bypasses all of that and
 * is permanent.
 *
 * So the double here does not return a fixed row: it reads whatever projection the service asks for and answers
 * with THAT projection's values, taken from a document row that really does hold a storage URL. Add `fileUrl` to
 * the selection and this spec goes red on the next run.
 */

const STORAGE_URL = "https://streamline-hr.r2.cloudflarestorage.com/org-no-url/hr-documents/x.pdf";

// One document row, as the table really holds it. `fileUrl` is the value every payload must be free of.
const DOCUMENT_ROW: Record<string, unknown> = {
  id: 501,
  orgId: ORG_ID,
  userId: "user-employee",
  departmentId: null,
  name: "Leave policy 2026",
  description: "How leave works",
  type: "POLICY",
  category: "POLICY",
  fileUrl: STORAGE_URL,
  hasFile: true,
  fileName: "leave-policy.pdf",
  fileSize: 2048,
  mimeType: "application/pdf",
  version: 1,
  parentDocumentId: null,
  isPublic: true,
  isActive: true,
  classification: "INTERNAL",
  effectiveDate: "2026-01-01",
  expiryDate: "2026-12-31",
  expiryReminderSent: false,
  tags: ["hr"],
  metadata: null,
  uploadedBy: ACTOR,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

/** A row shaped by the projection the service actually passed — the whole point of the spec. */
function rowFor(selection: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(selection).map((key) => [key, DOCUMENT_ROW[key] ?? null]));
}

const STATS_ROW = { total: 1, publicCount: 1, storageBytes: "2048", expiringCount: 1 };

function makeDb() {
  // `select` is used for the document list, the expiry list, the stats aggregates and the per-type counts.
  const select = jest.fn((selection: Record<string, unknown> = {}) => {
    const keys = Object.keys(selection);
    const rows = keys.includes("total")
      ? [STATS_ROW]
      : keys.length === 2 && keys.includes("type")
        ? [{ type: "POLICY", count: 1 }]
        : [rowFor(selection)];
    const builder: Record<string, unknown> = {};
    for (const step of ["from", "where", "orderBy", "groupBy", "limit", "innerJoin", "leftJoin"]) {
      builder[step] = jest.fn(() => builder);
    }
    builder["then"] = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
    return builder;
  });

  // No argument means drizzle returns the WHOLE row, storage URL and all — which is exactly the regression
  // this spec exists to catch, so the double reproduces it rather than answering an empty object.
  const returning = jest.fn((selection?: Record<string, unknown>) =>
    Promise.resolve([selection ? rowFor(selection) : { ...DOCUMENT_ROW }]),
  );
  const writeChain: Record<string, unknown> = { returning };
  for (const step of ["values", "set", "where"]) writeChain[step] = jest.fn(() => writeChain);

  return {
    select,
    insert: jest.fn(() => writeChain),
    update: jest.fn(() => writeChain),
    // The document-tag compatibility read and the target-membership lookup; neither carries a file.
    query: {
      documentTags: { findMany: jest.fn().mockResolvedValue([]) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 9 }) },
      certifications: { findMany: jest.fn().mockResolvedValue([]) },
    },
    transaction: jest.fn(async (callback: (tx: unknown) => unknown) => callback(txFor(writeChain, select))),
    execute: jest.fn().mockResolvedValue([]),
  };
}

function txFor(writeChain: Record<string, unknown>, select: jest.Mock) {
  return {
    select,
    insert: jest.fn(() => writeChain),
    update: jest.fn(() => writeChain),
    delete: jest.fn(() => writeChain),
    execute: jest.fn().mockResolvedValue([]),
    query: { documentTags: { findMany: jest.fn().mockResolvedValue([]) } },
  };
}

// A storage URL in any form, and the query parameters an S3/R2 presigned URL is recognised by.
const ANY_URL = /https?:\/\/|r2\.cloudflarestorage\.com|\.s3[.-][a-z0-9-]*\.amazonaws\.com/i;
const ANY_SIGNATURE = /X-Amz-Signature|X-Amz-Credential|[?&]Expires=/i;

function assertCarriesNoStorageUrl(payload: unknown, what: string): void {
  const serialised = JSON.stringify(payload);
  expect(`${what}: ${serialised}`).not.toMatch(ANY_URL);
  expect(`${what}: ${serialised}`).not.toMatch(ANY_SIGNATURE);
  expect(serialised).not.toContain(STORAGE_URL);
}

describe("no documents list payload carries a storage URL or a signature", () => {
  const audit = { logCritical: jest.fn().mockResolvedValue(undefined) };
  const read = ScopedRead.of(ORG_ID, ACTOR, "all");

  function build() {
    const db = makeDb();
    return { service: new DocumentsService(db as never, audit as never), db };
  }

  it("the fixture is real: the row under test does hold a storage URL, and the list says the file exists", async () => {
    const { service } = build();

    const page = await service.listDocuments(read, { limit: 20 } as never, 9);
    const [document] = page.data;

    // Without this the whole spec would pass over an empty payload.
    expect(DOCUMENT_ROW["fileUrl"]).toBe(STORAGE_URL);
    expect(document?.hasFile).toBe(true);
    expect(document?.fileName).toBe("leave-policy.pdf");
    expect(Object.keys(documentListSelection)).not.toContain("fileUrl");
  });

  it("the documents list does not", async () => {
    const { service } = build();
    assertCarriesNoStorageUrl(await service.listDocuments(read, { limit: 20 } as never, 9), "list");
  });

  it("the expiry list does not", async () => {
    const { service } = build();
    assertCarriesNoStorageUrl(await service.expiry(read, 30, 9), "expiry");
  });

  it("the stats summary does not", async () => {
    const { service } = build();
    assertCarriesNoStorageUrl(await service.stats(read, 9), "stats");
  });

  it("the create response does not, though the caller supplied the URL", async () => {
    const { service } = build();

    const created = await service.createDocument(
      read,
      { name: "Leave policy 2026", type: "POLICY", fileUrl: STORAGE_URL } as never,
      9,
    );

    expect(created.hasFile).toBe(true);
    assertCarriesNoStorageUrl(created, "create");
  });

  it("the update response does not", async () => {
    const { service, db } = build();
    // updateDocument reads the row it is about to change through `query.documents.findFirst`.
    (db.query as Record<string, unknown>)["documents"] = {
      findFirst: jest.fn().mockResolvedValue({ id: 501, userId: null, name: "n", type: "POLICY", isPublic: true, uploadedBy: ACTOR }),
    };

    assertCarriesNoStorageUrl(await service.updateDocument(read, 501, { name: "Renamed" } as never, 9), "update");
  });
});
