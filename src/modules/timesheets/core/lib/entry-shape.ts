export type EntryShapeInput = {
  id: number;
  orgId: string;
  userMembershipId: number | null;
  ticketId: number | null;
  projectId: number | null;
  date: string;
  hours: string;
  description: string | null;
  isBillable: boolean;
  billingType: string;
  status: string;
  submittedAt: Date | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectionReason: string | null;
  lockedAt: Date | null;
  voidedAt: Date | null;
  invoicingStatus: string;
  billRate: string | null;
  currency: string | null;
  rateSource: string | null;
  source: string;
  workLink: string | null;
  timesheetPeriodId: number | null;
  createdAt: Date;
  updatedAt: Date;
  directProjectId: number | null;
  directProjectName: string | null;
  ticketRowId: number | null;
  ticketTitle: string | null;
  ticketTicketNumber: number | null;
  ticketProjectId: number | null;
  ticketProjectName: string | null;
};

export function buildEntryShape(r: EntryShapeInput) {
  return {
    id: r.id,
    orgId: r.orgId,
    userMembershipId: r.userMembershipId,
    ticketId: r.ticketId,
    projectId: r.projectId,
    date: r.date,
    hours: r.hours,
    description: r.description,
    isBillable: r.isBillable,
    billingType: r.billingType,
    status: r.status,
    submittedAt: r.submittedAt,
    approvedBy: r.approvedBy,
    approvedAt: r.approvedAt,
    rejectionReason: r.rejectionReason,
    lockedAt: r.lockedAt,
    voidedAt: r.voidedAt,
    invoicingStatus: r.invoicingStatus,
    billRate: r.billRate,
    currency: r.currency,
    rateSource: r.rateSource,
    source: r.source,
    workLink: r.workLink,
    timesheetPeriodId: r.timesheetPeriodId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    project: r.directProjectId
      ? { id: r.directProjectId, name: r.directProjectName ?? "" }
      : null,
    ticket: r.ticketRowId
      ? {
          id: r.ticketRowId,
          title: r.ticketTitle ?? "",
          ticketNumber: r.ticketTicketNumber ?? 0,
          project: r.ticketProjectId
            ? { id: r.ticketProjectId, name: r.ticketProjectName ?? "" }
            : null,
        }
      : null,
  };
}
