import { Module } from "@nestjs/common";
import { RecordLayoutsController } from "./record-layouts.controller";
import { RecordLayoutsService } from "./record-layouts.service";

/**
 * The layout description is data, and this is where a tenant's own arrangement
 * of it lives. Platform infrastructure rather than a CRM module: the renderer
 * serves every record type, and Phase 4 puts the remaining modules on it.
 */
@Module({
  controllers: [RecordLayoutsController],
  providers: [RecordLayoutsService],
  exports: [RecordLayoutsService],
})
export class RendererModule {}
