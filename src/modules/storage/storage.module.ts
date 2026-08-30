import { Global, Module } from "@nestjs/common";
import { StorageService } from "./storage.service";
import { StorageController } from "./storage.controller";
import { OnboardingDocumentsController } from "./storage-onboarding.controller";
import { StorageKbController } from "./storage-kb.controller";
import { StorageVaultController } from "./storage-vault.controller";
import { MediaCompressionService } from "../../common/media/media-compression.service";
import { AvScannerModule } from "../../common/security/av-scanner.module";
import { AvScanner } from "../../common/security/av-scan";

@Global()
@Module({
  imports: [AvScannerModule],
  controllers: [
    StorageController,
    OnboardingDocumentsController,
    StorageKbController,
    StorageVaultController,
  ],
  providers: [MediaCompressionService, StorageService],
  exports: [StorageService, AvScanner],
})
export class StorageModule {}
