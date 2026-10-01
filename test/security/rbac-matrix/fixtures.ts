import type { Table } from "drizzle-orm";
import {
  jobPostings,
  projectAttachments,
  projectMembers,
  projectMilestones,
  projects,
  releaseTickets,
  supportTickets,
  tickets,
} from "src/db/schema";
import { ORG_A, ORG_B, membershipIdOf, standingRows, userOf } from "./standings";
import { mergeRows, worldDb, type Row, type WorldDb } from "./world-db";

export const PROJECT_A = 11;
export const SIBLING_PROJECT_A = 22;
export const TICKET_A = 901;
export const SIBLING_TICKET_A = 902;
export const FILE_A = 31;
export const MILESTONE_A = 41;
export const DELETED_MILESTONE_A = 42;
export const RELEASE_A = 5;
export const RELEASE_ASSIGNEE_A = `${ORG_A}:release-assignee`;
export const JOB_A = 4242;
export const RECRUITER_A = `${ORG_A}:recruiter`;
export const SUPPORT_TICKETS = [11, 12] as const;

function domainRows(): Map<Table, Row[]> {
  return new Map<Table, Row[]>([
    [
      projects,
      [
        { id: PROJECT_A, orgId: ORG_A, managerMembershipId: null, deletedAt: null },
        { id: SIBLING_PROJECT_A, orgId: ORG_A, managerMembershipId: null, deletedAt: null },
      ],
    ],
    [
      projectMembers,
      [
        {
          id: 1,
          orgId: ORG_A,
          projectId: PROJECT_A,
          membershipId: membershipIdOf("module:member", ORG_A),
          role: "MEMBER",
          userId: userOf("module:member", ORG_A),
          status: "ACTIVE",
        },
      ],
    ],
    [
      tickets,
      [
        { id: TICKET_A, orgId: ORG_A, projectId: PROJECT_A, deletedAt: null, allowed: true },
        { id: SIBLING_TICKET_A, orgId: ORG_A, projectId: SIBLING_PROJECT_A, deletedAt: null, allowed: true },
      ],
    ],
    [
      projectAttachments,
      [
        {
          id: FILE_A,
          orgId: ORG_A,
          projectId: PROJECT_A,
          deletedAt: null,
          storageKey: `${ORG_A}/files/${FILE_A}.pdf`,
          uploadedByMembershipId: membershipIdOf("module:admin", ORG_A),
        },
      ],
    ],
    [
      releaseTickets,
      [
        {
          orgId: ORG_A,
          releaseId: RELEASE_A,
          ticketId: TICKET_A,
          assigneeMembershipId: membershipIdOf("module:member", ORG_A),
          userId: RELEASE_ASSIGNEE_A,
        },
      ],
    ],
    [
      projectMilestones,
      [
        { id: MILESTONE_A, orgId: ORG_A, projectId: PROJECT_A, deletedAt: null },
        { id: DELETED_MILESTONE_A, orgId: ORG_A, projectId: PROJECT_A, deletedAt: new Date("2026-09-01T00:00:00Z") },
      ],
    ],
    [jobPostings, [{ id: JOB_A, orgId: ORG_A }]],
    [
      supportTickets,
      [
        ...SUPPORT_TICKETS.map((id) => ({ id, orgId: ORG_A })),
        ...SUPPORT_TICKETS.map((id) => ({ id, orgId: ORG_B })),
      ],
    ],
  ]);
}

export function matrixWorld(): WorldDb {
  return worldDb(mergeRows(standingRows(ORG_A), standingRows(ORG_B), domainRows()));
}
