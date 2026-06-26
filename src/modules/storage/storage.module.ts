import { Global, Module } from "@nestjs/common";
import { StorageService } from "./storage.service";
import { StorageController } from "./storage.controller";
import { OnboardingDocumentsController } from "./storage-onboarding.controller";
import { StorageKbController } from "./storage-kb.controller";
import { StorageVaultController } from "./storage-vault.controller";

@Global()
@Module({
  controllers: [
    StorageController,
    OnboardingDocumentsController,
    StorageKbController,
    StorageVaultController,
  ],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
