import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { runWithObservabilityContext } from "../../../common/observability";
import { vaultAccessLogs } from "../../../db/schema";
import { RecruitmentCandidateVaultService } from "./recruitment-candidate-vault.service";

interface InsertedRow {
  table: unknown;
  values: Record<string, unknown>;
}

function buildDb(document: Record<string, unknown> | undefined) {
  const inserted: InsertedRow[] = [];
  const deletes: unknown[] = [];
  let transactionCallbackRan = false;

  const tx = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserted.push({ table, values });
        return Promise.resolve([values]);
      },
    }),
    delete: (table: unknown) => ({
      where: () => {
        deletes.push(table);
        return Promise.resolve([]);
      },
    }),
  };

  const db = {
    query: {
      candidates: { findFirst: () => Promise.resolve({ id: 7 }) },
      candidateDocumentsVault: { findFirst: () => Promise.resolve(document) },
    },
    transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => {
      transactionCallbackRan = true;
      return fn(tx);
    },
  };

  return {
    db,
    inserted,
    deletes,
    ranTransaction: () => transactionCallbackRan,
  };
}

const DOCUMENT = { id: 42, filename: "offer-letter.pdf", documentType: "OFFER" };

describe("vault document deletion writes an audit row", () => {
  it("records the deletion and the document's name in the same transaction as the delete", async () => {
    const harness = buildDb(DOCUMENT);
    const service = new RecruitmentCandidateVaultService(harness.db as never);

    await service.deleteVaultDocument("org_1", 7, 42, "user_actor");

    expect(harness.ranTransaction()).toBe(true);
    expect(harness.inserted).toHaveLength(1);
    expect(harness.deletes).toHaveLength(1);
    expect(harness.inserted[0]?.table).toBe(vaultAccessLogs);
    expect(harness.inserted[0]?.values).toEqual({
      orgId: "org_1",
      candidateId: 7,
      vaultDocumentId: 42,
      filename: "offer-letter.pdf",
      documentType: "OFFER",
      accessedBy: "user_actor",
      action: "DELETE",
    });
  });

  it("attributes the deletion to the ambient actor when the caller passes none", async () => {
    const harness = buildDb(DOCUMENT);
    const service = new RecruitmentCandidateVaultService(harness.db as never);

    await runWithObservabilityContext(
      { correlationId: "corr-1", actorId: "user_ambient" },
      async () => service.deleteVaultDocument("org_1", 7, 42),
    );

    expect(harness.inserted[0]?.values.accessedBy).toBe("user_ambient");
  });

  it("refuses to delete at all when no actor can be identified", async () => {
    const harness = buildDb(DOCUMENT);
    const service = new RecruitmentCandidateVaultService(harness.db as never);

    await expect(service.deleteVaultDocument("org_1", 7, 42)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(harness.deletes).toHaveLength(0);
    expect(harness.inserted).toHaveLength(0);
  });

  it("writes nothing when the document does not belong to the candidate", async () => {
    const harness = buildDb(undefined);
    const service = new RecruitmentCandidateVaultService(harness.db as never);

    await expect(
      service.deleteVaultDocument("org_1", 7, 42, "user_actor"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.inserted).toHaveLength(0);
    expect(harness.deletes).toHaveLength(0);
  });
});

describe("the access-log reader no longer depends on the document surviving", () => {
  const source = readFileSync(join(__dirname, "recruitment-candidate-vault.service.ts"), "utf8");
  const reader = source.slice(
    source.indexOf("async listVaultAccessLogs"),
    source.indexOf("async getActivity"),
  );

  it("locates the reader", () => {
    expect(reader).toContain(".from(vaultAccessLogs)");
  });

  it("does not inner-join the vault, which would hide every deletion record", () => {
    expect(reader).not.toContain("innerJoin(\n        candidateDocumentsVault");
    expect(reader).not.toContain("innerJoin(candidateDocumentsVault");
  });

  it("filters on the log's own tenant and candidate columns", () => {
    expect(reader).toContain("eq(vaultAccessLogs.orgId, orgId)");
    expect(reader).toContain("eq(vaultAccessLogs.candidateId, candidateId)");
  });

  it("reads the file name from the log rather than the document", () => {
    expect(reader).toContain("fileName: vaultAccessLogs.filename");
    expect(reader).toContain("documentType: vaultAccessLogs.documentType");
  });
});

describe("the schema keeps the audit row alive", () => {
  const schema = readFileSync(
    join(__dirname, "../../../db/schema/hr/hiring-candidates.ts"),
    "utf8",
  );
  const block = schema.slice(
    schema.indexOf('export const vaultAccessLogs = pgTable("vault_access_logs"'),
    schema.indexOf('export const candidateReferenceChecks'),
  );

  const documentReference = block
    .split("\n")
    .find((line) => line.includes("vaultDocumentId:"));

  /**
   * The tenant relationship may be declared inline on the column or as a
   * composite `foreignKey({ columns: [orgId, vaultDocumentId] })`; the scan has
   * to see both, or a migration to the composite form reads as a lost rule.
   */
  const documentForeignKey = block
    .split("\n")
    .find(
      (line) =>
        line.includes("foreignKey(") && line.includes("table.vaultDocumentId"),
    );

  it("nulls the document reference on delete instead of cascading the audit row away", () => {
    const declaration = documentForeignKey ?? documentReference;
    expect(declaration).toBeDefined();
    expect(declaration).toMatch(/onDelete(:\s*|\(\s*)"set null"/);
    expect(declaration).not.toContain("cascade");
  });

  it("keeps the document reference tenant-scoped when it is declared as a composite", () => {
    if (!documentForeignKey) return;
    expect(documentForeignKey).toContain("table.orgId");
    expect(documentForeignKey).toContain("candidateDocumentsVault.orgId");
  });

  it("leaves the document reference nullable, so a nulled one is representable", () => {
    expect(documentReference).not.toContain("notNull()");
  });

  it("carries a tenant column so the table is inside the RLS sweep", () => {
    expect(block).toContain('text("org_id")');
  });

  it("denormalises what was deleted", () => {
    expect(block).toContain('text("filename")');
    expect(block).toContain('text("document_type")');
    expect(block).toContain('integer("candidate_id")');
  });
});
