import { Injectable } from "@nestjs/common";
import { RecruitmentCalibrationService } from "./recruitment-calibration.service";
import { RecruitmentReferralChecksService } from "./recruitment-referral-checks.service";
import { RecruitmentCandidateDocsService } from "./recruitment-candidate-docs.service";
import { RecruitmentCandidateVaultService } from "./recruitment-candidate-vault.service";
import type {
  AddVaultDocumentInput,
  CreateCalibrationInput,
  CreateReferenceCheckInput,
  CreateReferralInput,
  GenerateDocumentInput,
  RolloutDocumentsInput,
  UpdateCalibrationInput,
  UpdateReferenceCheckInput,
  UpdateReferralInput,
} from "./dto/candidate-records.schemas";

@Injectable()
export class RecruitmentCandidateRecordsService {
  constructor(
    private readonly calibration: RecruitmentCalibrationService,
    private readonly referralChecks: RecruitmentReferralChecksService,
    private readonly docs: RecruitmentCandidateDocsService,
    private readonly vault: RecruitmentCandidateVaultService,
  ) {}

  listCalibration(orgId: string, candidateId: number) {
    return this.calibration.listCalibration(orgId, candidateId);
  }

  createCalibration(orgId: string, userId: string, candidateId: number, input: CreateCalibrationInput) {
    return this.calibration.createCalibration(orgId, userId, candidateId, input);
  }

  updateCalibration(orgId: string, candidateId: number, input: UpdateCalibrationInput) {
    return this.calibration.updateCalibration(orgId, candidateId, input);
  }

  listReferrals(orgId: string, candidateId: number) {
    return this.referralChecks.listReferrals(orgId, candidateId);
  }

  createReferral(orgId: string, candidateId: number, input: CreateReferralInput) {
    return this.referralChecks.createReferral(orgId, candidateId, input);
  }

  updateReferral(orgId: string, candidateId: number, input: UpdateReferralInput) {
    return this.referralChecks.updateReferral(orgId, candidateId, input);
  }

  listReferenceChecks(orgId: string, candidateId: number) {
    return this.referralChecks.listReferenceChecks(orgId, candidateId);
  }

  createReferenceCheck(orgId: string, userId: string, candidateId: number, input: CreateReferenceCheckInput) {
    return this.referralChecks.createReferenceCheck(orgId, userId, candidateId, input);
  }

  updateReferenceCheck(orgId: string, candidateId: number, checkId: number, input: UpdateReferenceCheckInput) {
    return this.referralChecks.updateReferenceCheck(orgId, candidateId, checkId, input);
  }

  deleteReferenceCheck(orgId: string, candidateId: number, checkId: number) {
    return this.referralChecks.deleteReferenceCheck(orgId, candidateId, checkId);
  }

  listDocuments(orgId: string, candidateId: number) {
    return this.docs.listDocuments(orgId, candidateId);
  }

  generateDocument(orgId: string, userId: string, candidateId: number, input: GenerateDocumentInput) {
    return this.docs.generateDocument(orgId, userId, candidateId, input);
  }

  viewDocument(orgId: string, candidateId: number, documentId: number) {
    return this.docs.viewDocument(orgId, candidateId, documentId);
  }

  listRolloutDocuments(orgId: string, candidateId: number) {
    return this.docs.listRolloutDocuments(orgId, candidateId);
  }

  generateRolloutDocuments(orgId: string, userId: string, candidateId: number, input: RolloutDocumentsInput) {
    return this.docs.generateRolloutDocuments(orgId, userId, candidateId, input);
  }

  listVault(orgId: string, candidateId: number) {
    return this.vault.listVault(orgId, candidateId);
  }

  addVaultDocument(orgId: string, userId: string, candidateId: number, input: AddVaultDocumentInput) {
    return this.vault.addVaultDocument(orgId, userId, candidateId, input);
  }

  deleteVaultDocument(orgId: string, candidateId: number, documentId: number) {
    return this.vault.deleteVaultDocument(orgId, candidateId, documentId);
  }

  listVaultAccessLogs(orgId: string, candidateId: number) {
    return this.vault.listVaultAccessLogs(orgId, candidateId);
  }

  getActivity(orgId: string, candidateId: number) {
    return this.vault.getActivity(orgId, candidateId);
  }
}
