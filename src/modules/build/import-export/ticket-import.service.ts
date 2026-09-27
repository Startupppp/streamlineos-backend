import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import {
  COMMAND_FENCE_STORE,
  type CommandFenceStore,
} from "../../../common/idempotency/command-fence-store";
import { AccessService } from "../../access/access.service";
import { assertProjectAccess } from "../core/project-access";
import { lockProjectTicketMutation } from "../core/tickets/build-ticket-mutation-policy";
import { IMPORT_COMMAND_NAME, IMPORT_PERMISSION } from "./import-export.constants";
import { parseImportSource, type ImportFormat } from "./import-source";
import {
  buildTicketImportPreview,
  titleKey,
  type ImportPreviewRow,
  type TicketImportPreview,
} from "./ticket-import-preview";
import {
  nextTicketNumber,
  readConflictingTitleKeys,
  readProjectStatusNames,
} from "./ticket-import-reads";
import { insertTicketBatch, type ImportActor } from "./ticket-import-batches";
import { IMPORT_BATCH_SIZE } from "./import-export.constants";
import {
  skippedRows,
  summarize,
  type ImportMode,
  type ImportRowResult,
  type TicketImportReport,
} from "./ticket-import-report";

export interface ImportSourceInput {
  format: ImportFormat;
  content: string;
}

export interface CommitImportInput extends ImportSourceInput {
  confirmationToken: string;
  mode?: ImportMode;
  idempotencyKey?: string;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The batch could not be written";
}

@Injectable()
export class TicketImportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    @Inject(COMMAND_FENCE_STORE) private readonly fences: CommandFenceStore,
  ) {}

  async previewImport(
    u: CurrentUserContext,
    projectId: number,
    input: ImportSourceInput,
  ): Promise<TicketImportPreview> {
    await this.authorize(u, projectId);
    return this.buildPreview(u, projectId, input);
  }

  async commitImport(
    u: CurrentUserContext,
    projectId: number,
    input: CommitImportInput,
  ): Promise<TicketImportReport> {
    await this.authorize(u, projectId);
    const preview = await this.buildPreview(u, projectId, input);

    if (preview.fileError) throw new BadRequestException(preview.fileError);
    if (!preview.confirmationToken)
      throw new BadRequestException("No row in this file can be imported");
    if (preview.confirmationToken !== input.confirmationToken)
      throw new ConflictException(
        "This file no longer matches the preview it was confirmed from; preview it again",
      );

    const mode = input.mode ?? "atomic";
    const key = input.idempotencyKey ?? null;
    if (!key) return this.runImport(u, projectId, preview, mode, null);

    const claim = await this.fences.claim({
      orgId: u.orgId,
      audience: u.sessionId?.startsWith("pat:") ? "pat" : "internal",
      idempotencyKey: key,
      commandName: IMPORT_COMMAND_NAME,
      requestHash: preview.confirmationToken,
      principalId: u.userId,
    });

    if (claim.kind === "mismatch")
      throw new UnprocessableEntityException(
        "This idempotency key was already used for a different import",
      );
    if (claim.kind === "inflight")
      throw new ConflictException("This import is already running; retry shortly");
    if (claim.kind === "replay")
      return { ...(claim.responseBody as TicketImportReport), replayed: true };

    try {
      const report = await this.runImport(u, projectId, preview, mode, key);
      if (report.summary.imported === 0 && report.summary.rolledBack > 0)
        await this.fences.fail(claim.fenceId, u.orgId);
      else await this.fences.complete(claim.fenceId, 200, report, u.orgId);
      return report;
    } catch (error) {
      await this.fences.fail(claim.fenceId, u.orgId);
      throw error;
    }
  }

  private async authorize(u: CurrentUserContext, projectId: number): Promise<void> {
    await assertProjectAccess(this.db, this.access, u, projectId);
    if (!(await this.access.holds(u, IMPORT_PERMISSION)))
      throw new ForbiddenException("Not authorized to create tickets in this project");
  }

  private async buildPreview(
    u: CurrentUserContext,
    projectId: number,
    input: ImportSourceInput,
  ): Promise<TicketImportPreview> {
    const parsed = parseImportSource(input.format, input.content);
    const allowedStatuses = parsed.fileError
      ? []
      : await readProjectStatusNames(this.db, u.orgId, projectId);
    const candidateKeys = [
      ...new Set(
        parsed.rows
          .map((row) => row.values.title)
          .filter((title): title is string => typeof title === "string")
          .map(titleKey)
          .filter((key) => key !== ""),
      ),
    ];
    const existingTitleKeys = parsed.fileError
      ? []
      : await readConflictingTitleKeys(this.db, u.orgId, projectId, candidateKeys);

    return buildTicketImportPreview({
      orgId: u.orgId,
      projectId,
      parsed,
      allowedStatuses,
      existingTitleKeys,
    });
  }

  private async runImport(
    u: CurrentUserContext,
    projectId: number,
    preview: TicketImportPreview,
    mode: ImportMode,
    idempotencyKey: string | null,
  ): Promise<TicketImportReport> {
    const actor: ImportActor = {
      orgId: u.orgId,
      userId: u.userId,
      membershipId: actingMembershipId(u.principal),
    };
    const results =
      mode === "atomic"
        ? await this.runAtomic(actor, projectId, preview.rows)
        : await this.runPartial(actor, projectId, preview.rows);

    const rows = [...results, ...skippedRows(preview)].sort(
      (a, b) => a.rowNumber - b.rowNumber,
    );

    return {
      projectId,
      format: preview.format,
      mode,
      idempotencyKey,
      replayed: false,
      confirmationToken: preview.confirmationToken as string,
      summary: summarize(rows),
      rows,
      issues: preview.issues,
    };
  }

  private async runAtomic(
    actor: ImportActor,
    projectId: number,
    all: readonly ImportPreviewRow[],
  ): Promise<ImportRowResult[]> {
    try {
      return await this.db.transaction(async (tx) => {
        await lockProjectTicketMutation(tx as Db, actor.orgId, projectId);
        let number = await nextTicketNumber(tx, actor.orgId, projectId);
        const written: ImportRowResult[] = [];
        for (let offset = 0; offset < all.length; offset += IMPORT_BATCH_SIZE) {
          const batch = all.slice(offset, offset + IMPORT_BATCH_SIZE);
          const inserted = await insertTicketBatch(tx, actor, projectId, number, batch);
          number += batch.length;
          for (const row of inserted)
            written.push({
              rowNumber: row.rowNumber,
              outcome: "IMPORTED",
              ticketId: row.ticketId,
              message: null,
            });
        }
        return written;
      });
    } catch (error) {
      const message = failureMessage(error);
      return all.map((row) => ({
        rowNumber: row.rowNumber,
        outcome: "ROLLED_BACK" as const,
        ticketId: null,
        message,
      }));
    }
  }

  private async runPartial(
    actor: ImportActor,
    projectId: number,
    all: readonly ImportPreviewRow[],
  ): Promise<ImportRowResult[]> {
    const written: ImportRowResult[] = [];
    for (let offset = 0; offset < all.length; offset += IMPORT_BATCH_SIZE) {
      const batch = all.slice(offset, offset + IMPORT_BATCH_SIZE);
      try {
        const inserted = await this.db.transaction(async (tx) => {
          await lockProjectTicketMutation(tx as Db, actor.orgId, projectId);
          const number = await nextTicketNumber(tx, actor.orgId, projectId);
          return insertTicketBatch(tx, actor, projectId, number, batch);
        });
        for (const row of inserted)
          written.push({
            rowNumber: row.rowNumber,
            outcome: "IMPORTED",
            ticketId: row.ticketId,
            message: null,
          });
      } catch (error) {
        const message = failureMessage(error);
        for (const row of batch)
          written.push({
            rowNumber: row.rowNumber,
            outcome: "FAILED",
            ticketId: null,
            message,
          });
      }
    }
    return written;
  }
}
