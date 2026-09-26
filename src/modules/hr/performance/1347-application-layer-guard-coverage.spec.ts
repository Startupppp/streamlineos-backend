import { HttpException, HttpStatus } from "@nestjs/common";
import * as DocumentPiiScan from "./document-pii-scan";
import { SCANNED_DOCUMENT_FIELDS, METADATA_PII_BLOCKER_CODE } from "./document-pii-scan";
import { DocumentsService } from "./documents.service";
import { ScopedRead } from "../../access/scoped-read";
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
    builder["then"] = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve);
    return builder;
  });

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
    update: jest.fn(() => writeChain),
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
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error("The update resolved; it was expected to be refused.");
}

function piiPatchFor(field: (typeof SCANNED_DOCUMENT_FIELDS)[number]): UpdateDocumentInput {
  if (field === "name") return { name: `Content with ${PAN}` };
  if (field === "description") return { description: `Content with ${PAN}` };
  if (field === "category") return { category: PAN };
  return { tags: [PAN] };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("SCANNED_DOCUMENT_FIELDS drives the application-layer PII guard — adding a new field to the constant must automatically trigger a refusal here without any spec edit", () => {
  it("self-check: bypassing withMetadataPiiBlocker lets a PAN-bearing update through, proving each refusal below is sensitive to the scanner and not vacuously passing", async () => {
    const { service, transactionUpdate } = build({ liveLink: true });
    jest.spyOn(DocumentPiiScan, "withMetadataPiiBlocker").mockReturnValue([]);

    await service.updateDocument(
      read,
      DOCUMENT_ID,
      { name: `Content with ${PAN}` },
      MEMBERSHIP_ID,
      true,
    );

    expect(transactionUpdate).toHaveBeenCalled();
  });

  for (const field of SCANNED_DOCUMENT_FIELDS) {
    it(`refuses a PATCH that writes PAN into ${field} on a document with a live knowledge-base link`, async () => {
      const { service, transactionUpdate } = build({ liveLink: true });

      const refusal = await refusalOf(
        service.updateDocument(read, DOCUMENT_ID, piiPatchFor(field), MEMBERSHIP_ID, true),
      );

      expect(refusal.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(refusal.getResponse()).toMatchObject({
        code: "DOCUMENT_NOT_PUBLISHABLE",
        details: {
          blockers: [{ code: METADATA_PII_BLOCKER_CODE }],
        },
      });
      expect(transactionUpdate).not.toHaveBeenCalled();
    });
  }
});
