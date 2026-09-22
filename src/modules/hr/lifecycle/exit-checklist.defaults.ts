import {
  EXIT_CHECKLIST_CUSTOM_KEY_PREFIX,
  EXIT_CHECKLIST_KINDS,
  type ExitChecklistKind,
  type ExitChecklistQueue,
} from "./dto/exit-checklist.schemas";

export type ExitChecklistOwnerRule =
  | { type: "queue"; permission: ExitChecklistQueue }
  | { type: "manager" }
  | { type: "leaver" };

export interface ExitChecklistKindDefaults {
  title: string;
  dueOffsetDays: number;
  owner: ExitChecklistOwnerRule;
}

export const EXIT_CHECKLIST_KIND_DEFAULTS: Readonly<Record<ExitChecklistKind, ExitChecklistKindDefaults>> = {
  manager_handover: { title: "Manager handover of work, documents and open commitments", dueOffsetDays: -7, owner: { type: "manager" } },
  hr_clearance: { title: "HR clearance: notice period, leave balance and pending claims", dueOffsetDays: -1, owner: { type: "queue", permission: "hr:exit:manage" } },
  it_access_removal: { title: "IT access removed and verified on every system", dueOffsetDays: 0, owner: { type: "queue", permission: "hr:identity:manage" } },
  asset_return: { title: "Company assets returned and recorded", dueOffsetDays: 0, owner: { type: "queue", permission: "hr:assets:manage" } },
  final_settlement: { title: "Final settlement computed, approved and paid", dueOffsetDays: 30, owner: { type: "queue", permission: "hr:payroll:approve" } },
  documents: { title: "Experience and relieving letters issued", dueOffsetDays: 7, owner: { type: "queue", permission: "hr:exit:manage" } },
  exit_interview: { title: "Exit interview held and feedback recorded", dueOffsetDays: -3, owner: { type: "queue", permission: "hr:exit:manage" } },
  completion_evidence: { title: "Completion evidence filed and the exit closed", dueOffsetDays: 30, owner: { type: "queue", permission: "hr:exit:manage" } },
};

const LEGACY_TEMPLATE_TITLE_KINDS: ReadonlyMap<string, ExitChecklistKind> = new Map([
  ["initiate exit interview scheduling", "exit_interview"],
  ["revoke access to all systems (email, hrms)", "it_access_removal"],
  ["collect company laptop and assets", "asset_return"],
  ["process final settlement (fnf)", "final_settlement"],
  ["process final settlement", "final_settlement"],
  ["issue experience/relieving letter", "documents"],
  ["hand over pending work and documentation", "manager_handover"],
]);

const TEMPLATE_ROLE_OWNERS: Readonly<Record<string, ExitChecklistOwnerRule>> = {
  hr: { type: "queue", permission: "hr:exit:manage" },
  buddy: { type: "queue", permission: "hr:exit:manage" },
  it: { type: "queue", permission: "hr:identity:manage" },
  manager: { type: "manager" },
  employee: { type: "leaver" },
};

export interface OffboardingTemplateItem {
  id?: string;
  title: string;
  assigneeRole?: string;
  dueOffsetDays?: number;
}

export interface ExitChecklistAnchor {
  lastWorkingDate: string | null;
  noticePeriodDays: number;
  createdAt: Date;
}

export interface PlannedExitChecklistItem {
  itemKey: string;
  kind: ExitChecklistKind | "custom";
  title: string;
  dueDate: string;
  owner: ExitChecklistOwnerRule;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function shiftIsoDay(day: string, offsetDays: number): string {
  const match = ISO_DAY.exec(day);
  if (!match) throw new Error(`Not a YYYY-MM-DD day: ${day}`);
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

export function isoDayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function exitAnchorDay(anchor: ExitChecklistAnchor): string {
  if (anchor.lastWorkingDate) return anchor.lastWorkingDate;
  return shiftIsoDay(isoDayOf(anchor.createdAt), anchor.noticePeriodDays);
}

export function customItemKey(id: string): string {
  return `${EXIT_CHECKLIST_CUSTOM_KEY_PREFIX}${id}`;
}

export function kindOfItemKey(itemKey: string): ExitChecklistKind | "custom" {
  const typed = EXIT_CHECKLIST_KINDS.find((kind) => kind === itemKey);
  return typed ?? "custom";
}

export function planExitChecklist(
  anchor: ExitChecklistAnchor,
  templateItems: readonly OffboardingTemplateItem[],
): PlannedExitChecklistItem[] {
  const anchorDay = exitAnchorDay(anchor);
  const dueOverrides = new Map<ExitChecklistKind, number>();
  const custom: PlannedExitChecklistItem[] = [];

  templateItems.forEach((item, index) => {
    const kind = LEGACY_TEMPLATE_TITLE_KINDS.get(item.title.trim().toLowerCase());
    if (kind) {
      if (typeof item.dueOffsetDays === "number") dueOverrides.set(kind, item.dueOffsetDays);
      return;
    }
    const owner = TEMPLATE_ROLE_OWNERS[item.assigneeRole ?? ""] ?? TEMPLATE_ROLE_OWNERS["hr"];
    custom.push({
      itemKey: customItemKey(item.id ?? `template-${index + 1}`),
      kind: "custom",
      title: item.title.trim(),
      dueDate: shiftIsoDay(anchorDay, item.dueOffsetDays ?? 0),
      owner,
    });
  });

  const typed = EXIT_CHECKLIST_KINDS.map((kind): PlannedExitChecklistItem => {
    const defaults = EXIT_CHECKLIST_KIND_DEFAULTS[kind];
    return {
      itemKey: kind,
      kind,
      title: defaults.title,
      dueDate: shiftIsoDay(anchorDay, dueOverrides.get(kind) ?? defaults.dueOffsetDays),
      owner: defaults.owner,
    };
  });

  return [...typed, ...custom];
}
