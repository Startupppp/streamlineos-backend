import { Module } from "@nestjs/common";
import { SupportModule } from "./core/support.module";
import { SupportAttentionModule } from "./support-attention.module";
import { SupportKbGapModule } from "./kb-gap";

const SUPPORT_MODULES = [SupportModule, SupportAttentionModule, SupportKbGapModule];

@Module({
  imports: SUPPORT_MODULES,
  exports: SUPPORT_MODULES,
})
export class SupportRootModule {}
