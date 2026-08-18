/**
 * The default workflow every new project starts with.
 *
 * Single source of truth on purpose. Two copies previously existed and had drifted:
 * provisioning seeded TODO / IN_PROGRESS / IN_REVIEW / DONE with a `type`, while the template
 * path seeded "To Do" / "In Progress" / "Done" with no `type` at all. That produced two live
 * defects in template-created projects:
 *
 *   1. `tickets.status` defaults to 'TODO' and is a composite FK into project_statuses, so no
 *      status named 'TODO' meant every ticket insert failed the foreign key.
 *   2. `type` fell back to its column default 'unstarted', so the "Done" column was not typed
 *      as completed — and `type` is what every report reads to decide what "done" means. The
 *      board looked right while velocity, burndown and done-counts were wrong.
 *
 * `name` is the tenant-visible label and the FK target; `type` is the machine meaning. Renaming a
 * status is safe (the FK is ON UPDATE CASCADE); changing its `type` changes reporting.
 */
export const DEFAULT_PROJECT_STATUSES = [
  { name: "TODO", order: 0, color: "#e2e8f0", type: "unstarted" as const },
  { name: "IN_PROGRESS", order: 1, color: "#3b82f6", type: "started" as const },
  { name: "IN_REVIEW", order: 2, color: "#eab308", type: "started" as const },
  { name: "DONE", order: 3, color: "#22c55e", type: "completed" as const },
];
