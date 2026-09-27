import { KbPageContentType } from "../core/kb-content-type";

const DEFAULT_INTERVALS: Record<KbPageContentType, number> = {
  policy: 180,
  sop: 90,
  support_article: 120,
  runbook: 90,
  note: 365,
  troubleshooting: 365,
  decision_record: 365,
  meeting_notes: 365,
  project_brief: 365,
  playbook: 365,
};

export function computeVerificationInterval(
  contentType: KbPageContentType,
  override?: number,
): number {
  if (override !== undefined && override > 0) return override;
  return DEFAULT_INTERVALS[contentType] ?? 365;
}

export function shouldResetTrust(
  currentTrust: "unverified" | "verified" | "verification_expired",
  contentChanged: boolean,
): boolean {
  return contentChanged && currentTrust === "verified";
}
