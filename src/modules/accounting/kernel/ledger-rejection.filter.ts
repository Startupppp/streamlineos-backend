import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from "@nestjs/common";
import type { Response } from "express";
import { LedgerRejection, type LedgerRejectionCode } from "./ledger.types";

/**
 * Maps a `LedgerRejection` onto HTTP once, for every caller.
 *
 * A rejection is a *business* refusal — unbalanced, locked period, header
 * account — not a server fault. Each document layer used to have to remember to
 * translate it, and one that forgot turned "this period is closed" into a 500.
 * Catching it centrally means AR, AP, banking and the kernel all answer the same
 * way, and a new document type gets the behaviour for free.
 *
 * The machine-readable `code` and the offending `lineIndex` survive into the
 * body so a client can highlight the row instead of showing "posting failed".
 */
const NOT_FOUND_CODES: ReadonlySet<LedgerRejectionCode> = new Set([
  "ACCOUNT_NOT_FOUND",
  "BOOK_NOT_FOUND",
  "JOURNAL_NOT_FOUND",
]);

@Catch(LedgerRejection)
export class LedgerRejectionFilter implements ExceptionFilter<LedgerRejection> {
  private readonly logger = new Logger(LedgerRejectionFilter.name);

  catch(exception: LedgerRejection, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    // A cross-tenant or missing id resolves to 404, never 403 — a 403 would
    // confirm the row exists and turn a probe into an existence oracle.
    const status = NOT_FOUND_CODES.has(exception.code)
      ? HttpStatus.NOT_FOUND
      : HttpStatus.CONFLICT;

    this.logger.warn(
      `Ledger rejected a posting: ${exception.code} — ${exception.message}`,
    );

    response.status(status).json({
      statusCode: status,
      error: status === HttpStatus.NOT_FOUND ? "Not Found" : "Conflict",
      code: exception.code,
      message: exception.message,
      ...(exception.lineIndex !== undefined ? { lineIndex: exception.lineIndex } : {}),
      ...(exception.details ? { details: exception.details } : {}),
    });
  }
}
