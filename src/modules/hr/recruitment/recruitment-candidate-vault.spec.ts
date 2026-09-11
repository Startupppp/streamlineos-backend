import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { runWithObservabilityContext } from "../../../common/observability";
import { vaultAccessLogs } from "../../../db/schema";
import { storagePendingPurge } from "../../../db/schema/common/storage-pending-purge";
import { RecruitmentCandidateVaultService } from "./recruitment-candidate-vault.service";

const cleanQuarantine = {
  getStatusForKey: async () => "clean" as const,
} as unknown as import("../../storage/file-quarantine.service").FileQuarantineService;

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
        const settled = Promise.resolve([values]);
        return Object.assign(settled, { onConflictDoUpdate: () => settled });
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

const DOCUMENT = {
  id: 42,
  filename: "offer-letter.pdf",
  documentType: "OFFER",
  s3Key: "org_1/candidate-vault/42-offer-letter.pdf",
};

describe("vault document deletion writes an audit row", () => {
  it("records the deletion and the document's name in the same transaction as the delete", async () => {
    const harness = buildDb(DOCUMENT);
    const service = new RecruitmentCandidateVaultService(harness.db as never, cleanQuarantine);

    await service.deleteVaultDocument("org_1", 7, 42, "user_actor");

    expect(harness.ranTransaction()).toBe(true);
    expect(harness.deletes).toHaveLength(1);

    const auditRow = harness.inserted.find((r) => r.table === vaultAccessLogs);
    expect(auditRow).toBeDefined();
    expect(auditRow?.values).toEqual({
      orgId: "org_1",
      candidateId: 7,
      vaultDocumentId: 42,
      filename: "offer-letter.pdf",
      documentType: "OFFER",
      accessedBy: "user_actor",
      action: "DELETE",
    });

    /**
     * PRD-C103, "deletion must clean database rows and objects without
     * orphaning". The row is what points at the object, so the purge record has
     * to be written INSIDE the same transaction that removes it — otherwise a
     * crash between the two loses the only pointer and the object survives
     * forever, unreachable and still billed for.
     */
    const purgeRow = harness.inserted.find((r) => r.table === storagePendingPurge);
    expect(purgeRow).toBeDefined();
    expect(purgeRow?.values).toEqual({
      orgId: "org_1",
      storageKey: "org_1/candidate-vault/42-offer-letter.pdf",
      purpose: "recruitment:vault-document:delete",
      bucket: "default",
      status: "pending",
    });
  });

  it("attributes the deletion to the ambient actor when the caller passes none", async () => {
    const harness = buildDb(DOCUMENT);
    const service = new RecruitmentCandidateVaultService(harness.db as never, cleanQuarantine);

    await runWithObservabilityContext(
      { correlationId: "corr-1", actorId: "user_ambient" },
      async () => service.deleteVaultDocument("org_1", 7, 42),
    );

    expect(
      harness.inserted.find((r) => r.table === vaultAccessLogs)?.values.accessedBy,
    ).toBe("user_ambient");
  });

  it("refuses to delete at all when no actor can be identified", async () => {
    const harness = buildDb(DOCUMENT);
    const service = new RecruitmentCandidateVaultService(harness.db as never, cleanQuarantine);

    await expect(service.deleteVaultDocument("org_1", 7, 42)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(harness.deletes).toHaveLength(0);
    expect(harness.inserted).toHaveLength(0);
  });

  it("writes nothing when the document does not belong to the candidate", async () => {
    const harness = buildDb(undefined);
    const service = new RecruitmentCandidateVaultService(harness.db as never, cleanQuarantine);

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
    expect(documentForeignKey).toBeDefined();
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
