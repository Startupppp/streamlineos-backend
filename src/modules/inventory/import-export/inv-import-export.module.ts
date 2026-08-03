import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { ImportController } from "./import.controller";
import { ExportController } from "./export.controller";
import { ImportService } from "./import.service";
import { ExportService } from "./export.service";

@Module({
  imports: [InvStockEngineModule],
  controllers: [ImportController, ExportController],
  providers: [ImportService, ExportService],
})
export class InvImportExportModule {}
