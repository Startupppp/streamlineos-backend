import { BadRequestException } from "@nestjs/common";
import { decodeCursor } from "../../../common/pagination/cursor";
import { AutomationService } from "../../automation/automation.service";

export function decodeOnboardingSummaryCursor(value: string | undefined) {
  if (value === undefined) return null;
  const position = decodeCursor(value);
  if (!position) throw new BadRequestException("Invalid pagination cursor");
  try {
    const name: unknown = JSON.parse(position.sortValue);
    if (name !== null && typeof name !== "string") throw new Error();
    return { name: name as string | null, userId: position.id };
  } catch {
    throw new BadRequestException("Invalid pagination cursor");
  }
}

export function dispatchOnboardingDocumentSubmittedEvent(
  automation: AutomationService,
  orgId: string,
  documentId: number,
  targetUserId: string,
  documentTypeName: string,
): Promise<void> {
  return automation
    .runAutomationsForEvent(orgId, "onboarding.document_submitted", {
      documentId,
      userId: targetUserId,
      documentTypeName,
      status: "SUBMITTED",
      submittedAt: new Date().toISOString(),
    })
    .catch(() => undefined);
}
