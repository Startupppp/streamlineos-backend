import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { AssetsRecoveryService } from "../directory/assets-recovery.service";
import { HrAuditService } from "../core/hr-audit.service";
import { IdentityService } from "../enterprise-ops/identity/identity.service";
import { ExitChecklistService } from "./exit-checklist.service";

interface CompletionGateContext {
  orgId: string;
  actorUserId: string;
  resignationId: number;
  employeeUserId: string;
  overrideRequested: boolean;
  overrideReason?: string;
}

interface GateDefinition {
  name: string;
  check: () => Promise<boolean>;
  pendingMessage: string;
  unavailableMessage: string;
  reasonRequiredMessage: string;
  pendingAuditAction: string;
  unavailableAuditAction: string;
}

@Injectable()
export class ExitCompletionGuardService {
  private readonly logger = new Logger(ExitCompletionGuardService.name);

  constructor(
    private readonly assetsRecovery: AssetsRecoveryService,
    private readonly identity: IdentityService,
    private readonly hrAudit: HrAuditService,
    private readonly checklist: ExitChecklistService,
  ) {}

  async assertReady(context: CompletionGateContext): Promise<void> {
    await this.assertGate(context, {
      name: "asset recovery",
      check: () =>
        this.assetsRecovery.hasPendingRecovery(
          context.orgId,
          context.employeeUserId,
        ),
      pendingMessage:
        "Asset recovery is pending for this employee. Recover all assigned assets or complete with an override reason.",
      unavailableMessage:
        "Asset recovery status could not be verified. Completion was not saved. Try again when the service is available, or use an audited override.",
      reasonRequiredMessage:
        "An override reason is required to bypass pending or unavailable asset recovery verification.",
      pendingAuditAction: "asset_gate_overridden",
      unavailableAuditAction: "asset_gate_check_failed_overridden",
    });

    await this.assertGate(context, {
      name: "access revocation",
      check: () =>
        this.identity.hasUnverifiedRevokes(
          context.orgId,
          context.employeeUserId,
        ),
      pendingMessage:
        "Access removal is not verified for this employee. Verify all revocations or complete with an override reason.",
      unavailableMessage:
        "Access-removal status could not be verified. Completion was not saved. Try again when the service is available, or use an audited override.",
      reasonRequiredMessage:
        "An override reason is required to bypass pending or unavailable access-removal verification.",
      pendingAuditAction: "access_gate_overridden",
      unavailableAuditAction: "access_gate_check_failed_overridden",
    });

    await this.assertGate(context, {
      name: "offboarding checklist",
      check: async () =>
        (await this.checklist.openItemCount(context.orgId, context.resignationId)) > 0,
      pendingMessage:
        "Offboarding checklist items are still open. Close or waive every item, or complete with an override reason.",
      unavailableMessage:
        "The offboarding checklist could not be read. Completion was not saved. Try again when the service is available, or use an audited override.",
      reasonRequiredMessage:
        "An override reason is required to complete an exit with open or unreadable checklist items.",
      pendingAuditAction: "checklist_gate_overridden",
      unavailableAuditAction: "checklist_gate_check_failed_overridden",
    });
  }

  private async assertGate(
    context: CompletionGateContext,
    definition: GateDefinition,
  ): Promise<void> {
    let hasUnresolvedDependency: boolean;
    try {
      hasUnresolvedDependency = await definition.check();
    } catch (error) {
      this.logger.error(
        `Exit completion ${definition.name} check failed`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.requireAuditedOverride(
        context,
        definition.reasonRequiredMessage,
        definition.unavailableAuditAction,
        "verification_unavailable",
        new ServiceUnavailableException(definition.unavailableMessage),
      );
      return;
    }

    if (!hasUnresolvedDependency) return;

    await this.requireAuditedOverride(
      context,
      definition.reasonRequiredMessage,
      definition.pendingAuditAction,
      "dependency_pending",
      new BadRequestException(definition.pendingMessage),
    );
  }

  private async requireAuditedOverride(
    context: CompletionGateContext,
    reasonRequiredMessage: string,
    auditAction: string,
    gateStatus: "dependency_pending" | "verification_unavailable",
    blockedError: BadRequestException | ServiceUnavailableException,
  ): Promise<void> {
    if (!context.overrideRequested) throw blockedError;

    const reason = context.overrideReason?.trim();
    if (!reason) throw new BadRequestException(reasonRequiredMessage);

    await this.hrAudit.log({
      orgId: context.orgId,
      actorId: context.actorUserId,
      entityType: "resignations",
      entityId: String(context.resignationId),
      action: auditAction,
      after: { reason, gateStatus },
    });
  }
}
