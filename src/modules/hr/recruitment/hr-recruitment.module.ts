import { Module } from "@nestjs/common";
import { NotificationsModule } from "../../notifications/notifications.module";
import { AutomationModule } from "../../automation/automation.module";
import { AiModule } from "../../ai/core/ai.module";
import { BillingModule } from "../../billing/core/billing.module";
import { AccessModule } from "../../access/access.module";
import { RecruitmentCandidateDocumentsController } from "./recruitment-candidate-documents.controller";
import { RecruitmentCandidatesController } from "./recruitment-candidates.controller";
import { RecruitmentPipelineController } from "./recruitment-pipeline.controller";
import { RecruitmentCandidateRecordsController } from "./recruitment-candidate-records.controller";
import { RecruitmentOffersController } from "./recruitment-offers.controller";
import { RecruitmentOffersListController } from "./recruitment-offers-list.controller";
import { RecruitmentJobsController } from "./recruitment-jobs.controller";
import { RecruitmentRecruitersController } from "./recruitment-recruiters.controller";
import { RecruitmentSourcingController } from "./recruitment-sourcing.controller";
import { RecruitmentHeadcountController } from "./recruitment-headcount.controller";
import { RecruitmentAutomationController } from "./recruitment-automation.controller";
import { RecruitmentRequisitionsController } from "./recruitment-requisitions.controller";
import { RecruitmentJobBoardsController } from "./recruitment-job-boards.controller";
import { RecruitmentTalentPoolsController } from "./recruitment-talent-pools.controller";
import { RecruitmentCandidatesService } from "./recruitment-candidates.service";
import { RecruitmentCandidateOpsService } from "./recruitment-candidate-ops.service";
import { RecruitmentPipelineService } from "./recruitment-pipeline.service";
import { RecruitmentCalibrationService } from "./recruitment-calibration.service";
import { RecruitmentReferralChecksService } from "./recruitment-referral-checks.service";
import { RecruitmentCandidateDocsService } from "./recruitment-candidate-docs.service";
import { RecruitmentCandidateVaultService } from "./recruitment-candidate-vault.service";
import { RecruitmentOffersService } from "./recruitment-offers.service";
import { RecruitmentJobsService } from "./recruitment-jobs.service";
import { RecruitmentRecruitersService } from "./recruitment-recruiters.service";
import { RecruitmentSourcingService } from "./recruitment-sourcing.service";
import { RecruitmentVendorSourcingService } from "./recruitment-vendor-sourcing.service";
import { RecruitmentAutomationService } from "./recruitment-automation.service";
import { RecruitmentCandidateAiService } from "./recruitment-candidate-ai.service";
import { RecruitmentRequisitionsService } from "./recruitment-requisitions.service";
import { RecruitmentJobBoardsService } from "./recruitment-job-boards.service";
import { RecruitmentTalentPoolsService } from "./recruitment-talent-pools.service";
import { RecruitmentHandoffService } from "./recruitment-handoff.service";
import { RecruitmentWebhooksService } from "./webhooks/recruitment-webhooks.service";
import { HrWebhookDispatchService } from "./webhooks/hr-webhook-dispatch.service";
import { RecruitmentWebhookEmitter } from "./webhooks/webhook-emitter.service";
import { RecruitmentOutboxConsumer } from "./webhooks/recruitment-outbox-consumer";
import { ProviderCredentialsService } from "./integrations/provider-credentials.service";
import { JobBoardPublisherService } from "./boards/job-board-publisher.service";
import { JobBoardOutboxConsumer } from "./boards/job-board-outbox.consumer";
import { BoardApplyIngressService } from "./boards/board-apply-ingress.service";
import { BoardApplyIngressController } from "./boards/board-apply-ingress.controller";
import { RecruitmentIntegrationsService } from "./integrations/recruitment-integrations.service";
import { RecruitmentIntegrationsController } from "./integrations/recruitment-integrations.controller";
import { SourcedProfileService } from "./sourcing-extension/sourced-profile.service";
import { SourcingExtensionController } from "./sourcing-extension/sourcing-extension.controller";
import { UserApiTokensModule } from "../../api-tokens/user/user-api-tokens.module";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { RecruitmentOfferAcceptanceService } from "./recruitment-offer-acceptance.service";
import { RecruitmentOnboardingStartService } from "./recruitment-onboarding-start.service";
import { MembershipAdmissionModule } from "../../organization/core/membership-admission.module";
import { OnboardingModule } from "../onboarding/core/onboarding.module";

@Module({
  imports: [
    NotificationsModule,
    AutomationModule,
    AiModule,
    BillingModule,
    AccessModule,
    OutboxModule,
    MembershipAdmissionModule,
    OnboardingModule,
    /** The sourcing extension mints its token through the account token service rather than a second one. */
    UserApiTokensModule,
  ],
  controllers: [
    RecruitmentCandidateDocumentsController,
    RecruitmentCandidatesController,
    RecruitmentPipelineController,
    RecruitmentCandidateRecordsController,
    RecruitmentOffersController,
    RecruitmentOffersListController,
    RecruitmentJobsController,
    RecruitmentRecruitersController,
    RecruitmentSourcingController,
    RecruitmentHeadcountController,
    RecruitmentAutomationController,
    RecruitmentRequisitionsController,
    RecruitmentJobBoardsController,
    RecruitmentTalentPoolsController,
    BoardApplyIngressController,
    RecruitmentIntegrationsController,
    SourcingExtensionController,
  ],
  providers: [
    RecruitmentCandidatesService,
    RecruitmentCandidateOpsService,
    RecruitmentPipelineService,
    RecruitmentCalibrationService,
    RecruitmentReferralChecksService,
    RecruitmentCandidateDocsService,
    RecruitmentCandidateVaultService,
    RecruitmentOffersService,
    RecruitmentJobsService,
    RecruitmentRecruitersService,
    RecruitmentSourcingService,
    RecruitmentVendorSourcingService,
    RecruitmentAutomationService,
    RecruitmentCandidateAiService,
    RecruitmentRequisitionsService,
    RecruitmentJobBoardsService,
    RecruitmentTalentPoolsService,
    RecruitmentHandoffService,
    RecruitmentOfferAcceptanceService,
    RecruitmentOnboardingStartService,
    RecruitmentWebhooksService,
    HrWebhookDispatchService,
    RecruitmentWebhookEmitter,
    RecruitmentOutboxConsumer,
    ProviderCredentialsService,
    JobBoardPublisherService,
    JobBoardOutboxConsumer,
    BoardApplyIngressService,
    RecruitmentIntegrationsService,
    SourcedProfileService,
  ],
  exports: [
    RecruitmentOffersService,
    RecruitmentRequisitionsService,
    RecruitmentWebhooksService,
    HrWebhookDispatchService,
    RecruitmentOutboxConsumer,
    /** The public offer page runs the same acceptance effect as the internal button. */
    RecruitmentOfferAcceptanceService,
  ],
})
export class HrRecruitmentModule {}
