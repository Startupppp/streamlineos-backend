import { Module } from "@nestjs/common";
import { DrizzleModule } from "../../db/drizzle.module";
import { AttentionModule } from "../attention/attention.module";
import { CrmAttentionAdapter } from "./crm-attention-adapter";

@Module({
  imports: [DrizzleModule, AttentionModule],
  providers: [CrmAttentionAdapter],
})
export class CrmAttentionModule {}
