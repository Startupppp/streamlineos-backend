import { Module } from "@nestjs/common";
import { AttachmentsController } from "./attachments.controller";
import { AttachmentsService } from "./attachments.service";

/**
 * Attachments on accounting documents.
 *
 * Depends on nothing else in accounting: it resolves documents by reading the
 * owning tables directly rather than routing through AR and AP, which would
 * make this module import both and reintroduce an arrow pointing sideways.
 * `StorageService` arrives from the global `StorageModule`.
 *
 * Not registered in `app.module.ts` from here — `AccountingRootModule` wires it.
 */
@Module({
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AccountingAttachmentsModule {}
