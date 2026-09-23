import { Module } from "@nestjs/common";
import { DrizzleModule } from "../../db/drizzle.module";
import { AttentionModule } from "../attention/attention.module";
import { SupportAttentionAdapter } from "./support-attention-adapter";

@Module({
  imports: [DrizzleModule, AttentionModule],
  providers: [SupportAttentionAdapter],
})
export class SupportAttentionModule {}
