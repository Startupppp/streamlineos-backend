import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { ImportController } from "./import.controller";
import { ExportController } from "./export.controller";
import { ImportService } from "./import.service";
import { StagedImportService } from "./staged-import.service";
import { ExportService } from "./export.service";

@Module({
  imports: [InvStockEngineModule],
  controllers: [ImportController, ExportController],
  providers: [ImportService, StagedImportService, ExportService],
})
export class InvImportExportModule {}
