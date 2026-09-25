import { Global, Module } from "@nestjs/common";
import { StorageService } from "./storage.service";
import { StoragePurgeService } from "./storage-purge.service";
import { StoragePendingPurgeService } from "./storage-pending-purge.service";
import { FileQuarantineService } from "./file-quarantine.service";
import { StorageMultipartService } from "./storage-multipart.service";
import { StorageController } from "./storage.controller";
import { OnboardingDocumentsController } from "./storage-onboarding.controller";
import { StorageKbController } from "./storage-kb.controller";
import { StorageVaultController } from "./storage-vault.controller";
import { StorageQuarantineController } from "./storage-quarantine.controller";
import { StorageMultipartController } from "./storage-multipart.controller";
import { MediaCompressionService } from "../../common/media/media-compression.service";
import { MediaTransformRunner } from "./media-transform.runner";
import { AvScannerModule } from "../../common/security/av-scanner.module";
import { KbCoreModule } from "../kb/core/kb-core.module";

@Global()
@Module({
  imports: [AvScannerModule, KbCoreModule],
  controllers: [
    StorageController,
    OnboardingDocumentsController,
    StorageKbController,
    StorageVaultController,
    StorageQuarantineController,
    StorageMultipartController,
  ],
  providers: [
    MediaCompressionService,
    MediaTransformRunner,
    StorageService,
    StoragePurgeService,
    StoragePendingPurgeService,
    FileQuarantineService,
    StorageMultipartService,
  ],
  exports: [
    StorageService,
    StoragePendingPurgeService,
    FileQuarantineService,
    StorageMultipartService,
    MediaTransformRunner,
    AvScannerModule,
  ],
})
export class StorageModule {}
