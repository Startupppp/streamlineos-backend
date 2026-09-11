import { Module } from "@nestjs/common";
import { AccountingKernelModule } from "../kernel/accounting-kernel.module";
import { PartiesController } from "./parties.controller";
import { PartiesService } from "./parties.service";

/**
 * The party master, wired on its own so AR and AP can both import it without
 * either one owning it.
 *
 * It sits directly above the kernel: it needs `BooksService` to resolve the
 * book a party belongs to, and nothing else.
 */
@Module({
  imports: [AccountingKernelModule],
  controllers: [PartiesController],
  providers: [PartiesService],
  exports: [PartiesService],
})
export class PartiesModule {}
