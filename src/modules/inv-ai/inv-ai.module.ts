import { Module } from "@nestjs/common";
import { InvAiController } from "./inv-ai.controller";
import { InvAiService } from "./inv-ai.service";

@Module({
  controllers: [InvAiController],
  providers: [InvAiService],
  exports: [InvAiService],
})
export class InvAiModule {}
