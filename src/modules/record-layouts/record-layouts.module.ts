import { Module } from "@nestjs/common";
import { RecordLayoutsController } from "./record-layouts.controller";
import { RecordLayoutsService } from "./record-layouts.service";

/**
 * Ticket 20: per-tenant record layouts.
 *
 * A module rather than a pair of routes bolted onto the CRM controller, because
 * what it serves is not CRM: `party` is in the published set, and when subject
 * types and the HR record surfaces move onto the renderer they will be too. The
 * thing being arranged is a *description*, and descriptions are a platform
 * concern that the CRM happens to have the most of.
 *
 * No imports. The service takes `DRIZZLE`, and `PermissionGuard` resolves
 * `AccessService` from the `@Global` `AccessModule` — importing it explicitly
 * would add an edge `madge --circular` has to keep acyclic and buy nothing.
 *
 * It must be registered in `app.module.ts` to exist: an unregistered module
 * compiles green, typechecks green, and answers 404 for every route it declares.
 */
@Module({
  controllers: [RecordLayoutsController],
  providers: [RecordLayoutsService],
  exports: [RecordLayoutsService],
})
export class RecordLayoutsModule {}
