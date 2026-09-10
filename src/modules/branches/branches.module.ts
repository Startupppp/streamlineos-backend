import { Module } from "@nestjs/common";
import { BranchesController } from "./branches.controller";
import { BranchesReadService } from "./branches-read.service";

@Module({
  controllers: [BranchesController],
  providers: [BranchesReadService],
})
export class BranchesModule {}
