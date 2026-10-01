type StatusTally = { readonly status: string | null; readonly tally: number | string };

type InsightRows = {
  readonly projectRows: readonly StatusTally[];
  readonly submissionRows: readonly StatusTally[];
  readonly roadmapRows: readonly StatusTally[];
  readonly feedbackRows: readonly (StatusTally & { readonly votes: number | null })[];
};

function tallyOf(rows: readonly StatusTally[], status: string): number {
  return rows.reduce((total, row) => (row.status === status ? total + Number(row.tally) : total), 0);
}

export function foldProductInsights({ projectRows, submissionRows, roadmapRows, feedbackRows }: InsightRows) {
  const projectsByStatus = {
    active: tallyOf(projectRows, "ACTIVE"),
    completed: tallyOf(projectRows, "COMPLETED"),
    archived: tallyOf(projectRows, "ARCHIVED"),
  };
  const roadmapItemsByStatus = {
    planned: tallyOf(roadmapRows, "planned"),
    in_progress: tallyOf(roadmapRows, "in_progress"),
    completed: tallyOf(roadmapRows, "completed"),
    cancelled: tallyOf(roadmapRows, "cancelled"),
  };
  return {
    linkedProjectCount: projectsByStatus.active + projectsByStatus.completed + projectsByStatus.archived,
    projectsByStatus,
    submissionsByStatus: {
      open: tallyOf(submissionRows, "open"),
      in_progress: tallyOf(submissionRows, "in_progress"),
      resolved: tallyOf(submissionRows, "resolved"),
      archived: tallyOf(submissionRows, "archived"),
    },
    roadmapItemCount: Object.values(roadmapItemsByStatus).reduce((total, value) => total + value, 0),
    roadmapItemsByStatus,
    feedbackByStatus: {
      open: tallyOf(feedbackRows, "open"),
      planned: tallyOf(feedbackRows, "planned"),
      in_progress: tallyOf(feedbackRows, "in_progress"),
      completed: tallyOf(feedbackRows, "completed"),
      declined: tallyOf(feedbackRows, "declined"),
    },
    linkedFeedbackVoteCount: feedbackRows.reduce((total, row) => total + Number(row.votes ?? 0), 0),
  };
}
