import { Module } from "@nestjs/common";
import { BranchesController } from "./branches.controller";
import { BranchesService } from "./branches.service";
import { BranchesReadService } from "./branches-read.service";

@Module({
  controllers: [BranchesController],
  providers: [BranchesReadService, BranchesService],
})
export class BranchesModule {}
