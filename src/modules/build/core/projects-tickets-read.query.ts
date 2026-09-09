import { type Db } from "../../../db/drizzle.module";
import type { SQL } from "drizzle-orm";

const USER_COLS = {
  id: true,
  name: true,
  firstName: true,
  lastName: true,
  email: true,
  image: true,
} as const;

const TICKET_LIST_COLUMNS = {
  id: true,
  orgId: true,
  title: true,
  type: true,
  status: true,
  priority: true,
  projectId: true,
  ticketNumber: true,
  sprintId: true,
  epicId: true,
  assigneeMembershipId: true,
  reporterId: true,
  points: true,
  storyPoints: true,
  link: true,
  rank: true,
  parentTicketId: true,
  originalEstimate: true,
  timeSpent: true,
  startDate: true,
  dueDate: true,
  moduleId: true,
  cycleId: true,
  sequenceId: true,
  estimate: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function queryTickets(
  db: Db,
  where: SQL<unknown> | undefined,
  orderBy: SQL<unknown>[],
  limit: number,
) {
  const rows = await db.query.tickets.findMany({
    where,
    limit,
    columns: TICKET_LIST_COLUMNS,
    with: {
      assignee: { columns: {}, with: { user: { columns: USER_COLS } } },
      assignees: {
        with: { user: { columns: {}, with: { user: { columns: USER_COLS } } } },
      },
      labels: {
        with: {
          label: {
            columns: { id: true, orgId: true, name: true, color: true, createdAt: true },
          },
        },
      },
      cycle: {
        columns: {
          id: true,
          name: true,
          status: true,
          startDate: true,
          endDate: true,
        },
      },
    },
    orderBy,
  });
  return rows.map((row) => ({
    ...row,
    assigneeId: row.assignee?.user?.id ?? null,
    assignee: row.assignee?.user ?? null,
    assignees: row.assignees.flatMap((assignment) => {
      const user = assignment.user?.user;
      return user ? [{ ...assignment, userId: user.id, user }] : [];
    }),
  }));
}
