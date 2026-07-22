import { Global, Module } from "@nestjs/common";
import { StorageService } from "./storage.service";
import { StorageController } from "./storage.controller";
import { OnboardingDocumentsController } from "./storage-onboarding.controller";
import { StorageKbController } from "./storage-kb.controller";
import { StorageVaultController } from "./storage-vault.controller";
import { MediaCompressionService } from "../../common/media/media-compression.service";

@Global()
@Module({
  controllers: [
    StorageController,
    OnboardingDocumentsController,
    StorageKbController,
    StorageVaultController,
  ],
  providers: [MediaCompressionService, StorageService],
  exports: [StorageService],
})
export class StorageModule {}
