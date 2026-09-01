import { tickets } from "../../../db/schema";
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
  assigneeId: true,
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

export function queryTickets(
  db: Db,
  where: SQL<unknown> | undefined,
  orderBy: SQL<unknown>[],
  limit: number,
) {
  return db.query.tickets.findMany({
    where,
    limit,
    columns: TICKET_LIST_COLUMNS,
    with: {
      assignee: { columns: USER_COLS },
      assignees: {
        with: { user: { columns: USER_COLS } },
      },
      labels: {
        with: {
          label: {
            columns: { id: true, name: true, color: true },
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
}
