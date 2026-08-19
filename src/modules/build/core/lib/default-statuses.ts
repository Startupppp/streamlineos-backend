export const DEFAULT_PROJECT_STATUSES = [
  { name: "TODO", order: 0, color: "#e2e8f0", type: "unstarted" as const },
  { name: "IN_PROGRESS", order: 1, color: "#3b82f6", type: "started" as const },
  { name: "IN_REVIEW", order: 2, color: "#eab308", type: "started" as const },
  { name: "DONE", order: 3, color: "#22c55e", type: "completed" as const },
];
