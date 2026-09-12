import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { GenerateService } from "./generate.service";
import type { PayrollCommandReceiptsService } from "../command-receipts.service";

export async function executeRunGenerateCommand(
  receipts: PayrollCommandReceiptsService,
  generateService: GenerateService,
  u: CurrentUserContext,
  runId: number,
  isRecalc: boolean,
  idempotencyKey: string | undefined,
): Promise<{ ok: boolean; correlationId: string }> {
  const command = isRecalc ? "run.recalculate" : "run.generate";
  const key = idempotencyKey?.trim() || `${command}:${u.orgId}:${runId}`;
  const begin = await receipts.begin({
    orgId: u.orgId,
    command,
    idempotencyKey: key,
    actorId: u.userId,
    runId,
  });
  if (begin.kind === "replay") return begin.response as { ok: boolean; correlationId: string };
  if (begin.kind === "inflight") {
    throw new ConflictException("Generation already in progress for this key");
  }

  try {
    const result = await generateService.generateRun({ orgId: u.orgId, runId, actorId: u.userId, isRecalc });
    if (!result.ok) {
      await receipts.fail(begin.receiptId, result.reason);
      if (result.reason === "not_found") throw new NotFoundException("Payroll run not found");
      if (result.reason === "locked") {
        throw new BadRequestException(
          isRecalc ? "Cannot recalculate a locked run" : "Cannot generate a locked run",
        );
      }
      if (result.reason === "generation_in_progress") {
        throw new ConflictException("Payroll run is already being generated or recalculated");
      }
      throw new BadRequestException(result.reason);
    }
    const response = { ok: true, correlationId: begin.correlationId };
    await receipts.succeed(begin.receiptId, response);
    return response;
  } catch (err) {
    if (!(err instanceof NotFoundException || err instanceof BadRequestException || err instanceof ConflictException)) {
      await receipts.fail(begin.receiptId, err instanceof Error ? err.message : "generate failed");
    }
    throw err;
  }
}
