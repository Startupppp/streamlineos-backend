import { HttpException, HttpStatus } from "@nestjs/common";
import { DocumentsService } from "./documents.service";
import { ScopedRead } from "../../access/scoped-read";
import { publishBlockers } from "./documents-helpers";
import { METADATA_PII_BLOCKER_CODE, withMetadataPiiBlocker } from "./document-pii-scan";
import type { UpdateDocumentInput } from "./dto/documents.schemas";

const ORG_ID = "org-live";
const HR_USER = "user-hr";
const MEMBERSHIP_ID = 9;
const DOCUMENT_ID = 77;

const PAN = "ABCDE1234F";

const PUBLISHABLE_DOCUMENT = {
  id: DOCUMENT_ID,
  orgId: ORG_ID,
  userId: HR_USER,
  name: "Leave policy 2026",
  description: "How leave works at the company.",
  category: "Policies",
  tags: ["hr", "policy"],
  type: "POLICY",
  classification: "INTERNAL",
  fileUrl: "org-live/hr-documents/leave-policy.pdf",
  isActive: true,
  isPublic: false,
  metadata: null,
  uploadedBy: HR_USER,
};

function makeDb(options: { liveLink: boolean }) {
  const setPayloads: Record<string, unknown>[] = [];
  const writeChain: Record<string, unknown> = {
    set: jest.fn((values: Record<string, unknown>) => {
      setPayloads.push(values);
      return writeChain;
    }),
    returning: jest.fn(() => Promise.resolve([{ id: DOCUMENT_ID, name: "persisted" }])),
  };
  for (const step of ["values", "where"]) writeChain[step] = jest.fn(() => writeChain);

  const select = jest.fn((selection: Record<string, unknown> = {}) => {
    const rows =
      Object.keys(selection).includes("liveLinkId") && options.liveLink
        ? [{ liveLinkId: 4242 }]
        : [];
    const builder: Record<string, unknown> = {};
    for (const step of ["from", "where", "orderBy", "groupBy", "limit"]) {
      builder[step] = jest.fn(() => builder);
    }
    builder["then"] = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
    return builder;
  });

  const update = jest.fn(() => writeChain);
  const transactionUpdate = jest.fn(() => writeChain);
  const tx = {
    select,
    update: transactionUpdate,
    insert: jest.fn(() => writeChain),
    delete: jest.fn(() => writeChain),
    execute: jest.fn().mockResolvedValue([]),
  };

  const db = {
    select,
    update,
    insert: jest.fn(() => writeChain),
    delete: jest.fn(() => writeChain),
    execute: jest.fn().mockResolvedValue([]),
    query: {
      documents: { findFirst: jest.fn().mockResolvedValue({ ...PUBLISHABLE_DOCUMENT }) },
      documentTags: { findMany: jest.fn().mockResolvedValue([]) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: MEMBERSHIP_ID }) },
    },
    transaction: jest.fn(async (callback: (handle: unknown) => unknown) => callback(tx)),
  };

  return { db, setPayloads, transactionUpdate };
}

function build(options: { liveLink: boolean }) {
  const { db, setPayloads, transactionUpdate } = makeDb(options);
  const audit = { logCritical: jest.fn().mockResolvedValue(undefined) };
  return {
    service: new DocumentsService(db as never, audit as never),
    setPayloads,
    transactionUpdate,
  };
}

const read = ScopedRead.of(ORG_ID, HR_USER, "all");

async function refusalOf(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error("The update resolved; it was expected to be refused.");
}

function responseOf(error: HttpException): {
  code?: string;
  details?: { blockers?: Array<{ code: string; message: string }> };
} {
  return error.getResponse() as {
    code?: string;
    details?: { blockers?: Array<{ code: string; message: string }> };
  };
}

describe("updating a document re-runs the publish judgement over the four searchable metadata fields", () => {
  it("the fixture is real: with clean metadata the document clears every publish blocker, so no assertion below passes over an already-blocked row", () => {
    expect(withMetadataPiiBlocker(publishBlockers(PUBLISHABLE_DOCUMENT), PUBLISHABLE_DOCUMENT)).toEqual([]);
  });

  const scannedFieldCases: ReadonlyArray<
    readonly [field: string, reason: string, patch: UpdateDocumentInput]
  > = [
    [
      "name",
      "the name is indexed into the company-wide search vector and rendered as the entry title the moment it is written",
      { name: `Leave policy ${PAN}` },
    ],
    [
      "description",
      "the description is concatenated verbatim into the Ask prompt, so a manage-only holder could otherwise put an identifier in every asker's AI context",
      { description: `Queries to ${PAN} please.` },
    ],
    [
      "category",
      "the category is one of the four columns concatenated into the tsvector, so it is searchable company-wide",
      { category: PAN },
    ],
    [
      "tags",
      "the tags array is joined into the same tsvector, so a tag carrying an identifier is as searchable as the name",
      { tags: ["hr", PAN] },
    ],
  ];

  for (const [field, reason, patch] of scannedFieldCases) {
    it(`refuses a PATCH that puts a personal identifier in ${field} on a document with a live knowledge-base link, because ${reason}`, async () => {
      const { service, setPayloads, transactionUpdate } = build({ liveLink: true });

      const error = await refusalOf(
        service.updateDocument(read, DOCUMENT_ID, patch, MEMBERSHIP_ID, true),
      );

      expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      const response = responseOf(error);
      expect(response.code).toBe("DOCUMENT_NOT_PUBLISHABLE");
      const [blocker] = response.details?.blockers ?? [];
      expect(blocker?.code).toBe(METADATA_PII_BLOCKER_CODE);
      expect(blocker?.message).toContain(field);
      expect(blocker?.message).toContain("PAN");
      expect(transactionUpdate).not.toHaveBeenCalled();
      expect(setPayloads).toEqual([]);
      expect(JSON.stringify(response)).not.toContain(PAN);
    });
  }

  it("allows the very same identifier-bearing rename when the document has no live knowledge-base link, because nothing is indexing it and refusing here would make every assertion above vacuous", async () => {
    const { service, setPayloads, transactionUpdate } = build({ liveLink: false });

    await service.updateDocument(
      read,
      DOCUMENT_ID,
      { name: `Leave policy ${PAN}` },
      MEMBERSHIP_ID,
      true,
    );

    expect(transactionUpdate).toHaveBeenCalled();
    expect(setPayloads[0]).toMatchObject({ name: `Leave policy ${PAN}` });
  });

  it("leaves a PATCH to an unscanned field alone on a linked document, because expiryDate reaches neither the search vector nor the prompt", async () => {
    const { service, setPayloads, transactionUpdate } = build({ liveLink: true });

    await service.updateDocument(
      read,
      DOCUMENT_ID,
      { expiryDate: "2027-12-31" },
      MEMBERSHIP_ID,
      false,
    );

    expect(transactionUpdate).toHaveBeenCalled();
    expect(setPayloads[0]).toMatchObject({ expiryDate: "2027-12-31" });
  });

  it("still writes clean metadata to a linked document, so the judgement refuses identifiers rather than refusing edits", async () => {
    const { service, setPayloads, transactionUpdate } = build({ liveLink: true });

    await service.updateDocument(
      read,
      DOCUMENT_ID,
      { name: "Leave policy 2027", description: "Rewritten for the new year.", tags: ["hr"] },
      MEMBERSHIP_ID,
      true,
    );

    expect(transactionUpdate).toHaveBeenCalled();
    expect(setPayloads[0]).toMatchObject({
      name: "Leave policy 2027",
      description: "Rewritten for the new year.",
      tags: ["hr"],
    });
  });

  it("refuses a manage-only holder editing a searchable field on a linked document, because rewriting what the company-wide index serves is the publish decision under another name", async () => {
    const { service, setPayloads, transactionUpdate } = build({ liveLink: true });

    const error = await refusalOf(
      service.updateDocument(read, DOCUMENT_ID, { name: "Leave policy 2027" }, MEMBERSHIP_ID, false),
    );

    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(responseOf(error).code).toBe("PUBLISH_PERMISSION_REQUIRED");
    expect(transactionUpdate).not.toHaveBeenCalled();
    expect(setPayloads).toEqual([]);
  });
});
