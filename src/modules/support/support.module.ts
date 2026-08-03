import { Module } from "@nestjs/common";
import { SupportModule } from "./core/support.module";
import { SupportKbGapModule } from "./kb-gap";

const SUPPORT_MODULES = [SupportModule, SupportKbGapModule];

@Module({
  imports: SUPPORT_MODULES,
  exports: SUPPORT_MODULES,
})
export class SupportRootModule {}
