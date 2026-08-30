import { Module } from "@nestjs/common";
import { NoopWesAdapter } from "./wes-adapter";

/**
 * NEO-13. A provider and nothing else: there is no controller, because there is
 * nothing here a person can do. When a real adapter exists it is registered
 * beside the noop and chosen by configuration - and the picking path does not
 * change, which is the whole reason the boundary was fixed first.
 */
@Module({
  providers: [NoopWesAdapter],
  exports: [NoopWesAdapter],
})
export class InvWesModule {}
