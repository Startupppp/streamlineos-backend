import type { Table } from "drizzle-orm";
import {
  chatChannelMembers,
  chatChannels,
  gitTicketLinks,
  jobPostings,
  projectAttachments,
  projectMembers,
  projectMilestones,
  projectViews,
  projects,
  releaseTickets,
  supportTickets,
  tickets,
} from "src/db/schema";
import { ORG_A, ORG_B, VARIANTS, membershipIdOf, standingRows } from "./standings";
import { mergeRows, worldDb, type Row, type WorldDb } from "./world-db";

export const PROJECT_A = 11;
export const SIBLING_PROJECT_A = 22;
export const DELETED_PROJECT_A = 33;
export const ARCHIVED_PROJECT_A = 44;
export const TICKET_A = 901;
export const SIBLING_TICKET_A = 902;
export const DELETED_PARENT_TICKET_A = 903;
export const ARCHIVED_TICKET_A = 904;
export const FILE_A = 31;
export const MILESTONE_A = 41;
export const DELETED_MILESTONE_A = 42;
export const ORPHANED_MILESTONE_A = 43;
export const RELEASE_A = 5;
export const JOB_A = 4242;
export const RECRUITER_A = `${ORG_A}:recruiter`;
export const SUPPORT_TICKETS: Readonly<Record<string, readonly number[]>> = { [ORG_A]: [11, 12], [ORG_B]: [21, 22] };
export const CHAT_CHANNELS: Readonly<Record<string, readonly number[]>> = { [ORG_A]: [7, 9], [ORG_B]: [8] };

const DELETED_AT = new Date("2026-09-01T00:00:00Z");

function project(id: number, overrides: Partial<Record<string, unknown>> = {}): Row {
  return { id, orgId: ORG_A, managerMembershipId: null, deletedAt: null, status: "ACTIVE", ...overrides };
}

function ticket(id: number, projectId: number): Row {
  return {
    id,
    orgId: ORG_A,
    projectId,
    deletedAt: null,
    assigneeMembershipId: membershipIdOf("module:member", ORG_A),
    reporterId: null,
    parentTicketId: null,
  };
}

function projectSeat(id: number, projectId: number, membershipId: number): Row {
  return { id, orgId: ORG_A, projectId, membershipId, role: "MEMBER" };
}

function chatRows(orgId: string): { channels: Row[]; members: Row[] } {
  const ids = CHAT_CHANNELS[orgId] ?? [];
  return {
    channels: ids.map((id) => ({ id, orgId, isArchived: false, lastMessageAt: new Date(id * 1000), entityType: null, entityId: null })),
    members: ids.map((channelId, index) => ({
      id: channelId * 10 + index,
      orgId,
      channelId,
      membershipId: membershipIdOf("org:member", orgId),
    })),
  };
}

function domainRows(): Map<Table, Row[]> {
  const memberSeats = [undefined, ...VARIANTS.filter((variant) => variant !== "expired-role")].map((variant) =>
    membershipIdOf("module:member", ORG_A, variant),
  );
  const chatA = chatRows(ORG_A);
  const chatB = chatRows(ORG_B);
  return new Map<Table, Row[]>([
    [
      projects,
      [
        project(PROJECT_A),
        project(SIBLING_PROJECT_A),
        project(DELETED_PROJECT_A, { deletedAt: DELETED_AT }),
        project(ARCHIVED_PROJECT_A, { status: "ARCHIVED" }),
      ],
    ],
    [
      projectMembers,
      [
        ...memberSeats.map((membershipId, index) => projectSeat(1 + index, PROJECT_A, membershipId)),
        projectSeat(10, DELETED_PROJECT_A, membershipIdOf("module:member", ORG_A)),
        projectSeat(11, ARCHIVED_PROJECT_A, membershipIdOf("module:member", ORG_A)),
      ],
    ],
    [
      tickets,
      [
        ticket(TICKET_A, PROJECT_A),
        ticket(SIBLING_TICKET_A, SIBLING_PROJECT_A),
        ticket(DELETED_PARENT_TICKET_A, DELETED_PROJECT_A),
        ticket(ARCHIVED_TICKET_A, ARCHIVED_PROJECT_A),
      ],
    ],
    [gitTicketLinks, []],
    [projectViews, []],
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
    [releaseTickets, [{ orgId: ORG_A, releaseId: RELEASE_A, ticketId: TICKET_A }]],
    [
      projectMilestones,
      [
        { id: MILESTONE_A, orgId: ORG_A, projectId: PROJECT_A, deletedAt: null },
        { id: DELETED_MILESTONE_A, orgId: ORG_A, projectId: PROJECT_A, deletedAt: DELETED_AT },
        { id: ORPHANED_MILESTONE_A, orgId: ORG_A, projectId: DELETED_PROJECT_A, deletedAt: null },
      ],
    ],
    [jobPostings, [{ id: JOB_A, orgId: ORG_A }]],
    [
      supportTickets,
      Object.entries(SUPPORT_TICKETS).flatMap(([orgId, ids]) =>
        ids.map((id) => ({ id, orgId, assigneeMembershipId: membershipIdOf("module:member", orgId), deletedAt: null })),
      ),
    ],
    [chatChannels, [...chatA.channels, ...chatB.channels]],
    [chatChannelMembers, [...chatA.members, ...chatB.members]],
  ]);
}

export function matrixRows(): Map<Table, Row[]> {
  return mergeRows(standingRows(ORG_A), standingRows(ORG_B), domainRows());
}

export function matrixWorld(): WorldDb {
  return worldDb(matrixRows());
}
