export interface ChecklistItemRecord {
  id: number;
  orgId: string;
  checklistId: number;
  text: string;
  isCompleted: boolean;
  assigneeId: string | null;
  dueDate: string | null;
  order: number;
  createdAt: Date;
}

export function toChecklistItemRow(item: ChecklistItemRecord) {
  return {
    id: item.id,
    orgId: item.orgId,
    checklistId: item.checklistId,
    text: item.text,
    isCompleted: item.isCompleted,
    assigneeId: item.assigneeId ?? null,
    dueDate: item.dueDate ?? null,
    order: item.order,
    createdAt: item.createdAt,
  };
}
