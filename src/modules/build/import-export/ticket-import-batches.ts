import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { IMPORT_BATCH_SIZE } from "./import-export.constants";
import type { ImportPreviewRow } from "./ticket-import-preview";
import {
  BuildTicketCreationService,
  type CreatedBuildTickets,
} from "../core/tickets";

export interface ImportActor {
  orgId: string;
  userId: string;
  membershipId: number | null;
}

export interface InsertedRow {
  rowNumber: number;
  ticketId: number;
}

export interface InsertedTicketBatch {
  rows: InsertedRow[];
  creation: CreatedBuildTickets;
}

export function chunkRows<T>(rows: readonly T[], size: number = IMPORT_BATCH_SIZE): T[][] {
  if (size < 1) throw new RangeError("Batch size must be at least 1");
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size)
    chunks.push(rows.slice(index, index + size));
  return chunks;
}

export async function insertTicketBatch(
  tx: DbOrTx,
  ticketCreation: BuildTicketCreationService,
  actor: ImportActor,
  projectId: number,
  startNumber: number,
  batch: readonly ImportPreviewRow[],
): Promise<InsertedTicketBatch> {
  void startNumber;
  if (batch.length === 0) {
    const creation = await ticketCreation.createInTransaction(tx as never, {
      orgId: actor.orgId,
      projectId,
      actor: { userId: actor.userId, membershipId: actor.membershipId },
      drafts: [],
    });
    return { rows: [], creation };
  }

  const values = batch.map((row) => ({
    orgId: actor.orgId,
    projectId,
    title: row.values.title,
    description: row.values.description ?? null,
    type: row.values.type ?? "TASK",
    status: row.values.status,
    priority: row.values.priority ?? "MEDIUM",
    startDate: row.values.startDate ?? null,
    dueDate: row.values.dueDate ?? null,
    points: row.values.points ?? row.values.storyPoints ?? null,
    estimate: row.values.estimate ?? null,
    completionPercentage: row.values.completionPercentage ?? 0,
    clientVisible: row.values.clientVisible ?? false,
    link: row.values.link ?? null,
    reporterId: actor.userId,
    reporterMembershipId: actor.membershipId,
  }));

  const creation = await ticketCreation.createInTransaction(tx as never, {
    orgId: actor.orgId,
    projectId,
    actor: { userId: actor.userId, membershipId: actor.membershipId },
    drafts: values,
  });

  return { rows: creation.tickets.map((created, index) => ({
    rowNumber: batch[index]?.rowNumber ?? -1,
    ticketId: created.id,
  })), creation };
}
