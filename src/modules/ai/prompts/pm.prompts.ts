export interface SummaryPromptContext {
  projectName: string;
  status: string;
  totalTasks: number;
  done: number;
  inProgress: number;
  blocked: number;
  overdue: number;
  sprintProgressPct?: number;
}

export function summaryPrompt(ctx: SummaryPromptContext) {
  return {
    system: `You are an expert project manager AI. Summarize the project's health concisely and accurately from the data provided. Never reference internal costs, hourly rates, or assignee names.`,
    user: `Summarize project "${ctx.projectName}" (status: ${ctx.status}):
Tasks: ${ctx.totalTasks} total | ${ctx.done} done | ${ctx.inProgress} in-progress | ${ctx.blocked} blocked | ${ctx.overdue} overdue${ctx.sprintProgressPct !== undefined ? `\nActive sprint: ${ctx.sprintProgressPct}% complete` : ""}`,
  };
}

export interface RisksPromptContext {
  projectName: string;
  overdueTasks: number;
  blockedTasks: number;
  activeSprintsOverdue: number;
  openChangeRequests: number;
  pendingApprovals: number;
  daysUntilDeadline?: number;
}

export function risksPrompt(ctx: RisksPromptContext) {
  return {
    system: `You are a project risk analyst. Identify concrete, specific risks from the project metrics. Do not fabricate data beyond what is provided. Order risks by severity descending.`,
    user: `Identify risks for project "${ctx.projectName}":
Overdue tasks: ${ctx.overdueTasks}
Blocked tasks: ${ctx.blockedTasks}
Active sprints past end date: ${ctx.activeSprintsOverdue}
Open change requests: ${ctx.openChangeRequests}
Pending approvals: ${ctx.pendingApprovals}${ctx.daysUntilDeadline !== undefined ? `\nDays until project deadline: ${ctx.daysUntilDeadline}` : ""}`,
  };
}

export interface ClientUpdatePromptContext {
  projectName: string;
  visibleTasks: Array<{ title: string; status: string; priority: string }>;
  visibleMilestones: Array<{ title: string; status: string }>;
}

export function clientUpdatePrompt(ctx: ClientUpdatePromptContext) {
  const taskLines = ctx.visibleTasks
    .slice(0, 20)
    .map((t) => `- [${t.status}] ${t.title}`)
    .join("\n");
  const milestoneLines = ctx.visibleMilestones
    .map((m) => `- [${m.status}] ${m.title}`)
    .join("\n");

  return {
    system: `You are a client communications specialist. Draft a professional, client-safe project status update.
CRITICAL: You have been given ONLY client-visible data. Do NOT reference internal costs, estimates, team member names, or internal metrics. Use business-friendly language.`,
    user: `Draft a client update for "${ctx.projectName}":
${taskLines ? `\nClient-visible tasks:\n${taskLines}` : "\nNo client-visible tasks shared yet."}
${milestoneLines ? `\nMilestones:\n${milestoneLines}` : ""}`,
  };
}

export interface PlanPromptContext {
  projectName: string;
  projectDescription?: string | null;
  existingOpenTaskTitles: string[];
  userPrompt: string;
}

export function planPrompt(ctx: PlanPromptContext) {
  const existingStr = ctx.existingOpenTaskTitles.length
    ? ctx.existingOpenTaskTitles.slice(0, 30).join("; ")
    : "none";
  return {
    system: `You are an expert project planner. Propose a structured plan with milestones and tasks. Avoid duplicating existing open tasks. These are SUGGESTIONS ONLY — do not imply they will be auto-created.`,
    user: `Project: "${ctx.projectName}"${ctx.projectDescription ? `\nDescription: ${ctx.projectDescription}` : ""}
Existing open tasks (avoid duplicating): ${existingStr}
Planning request: ${ctx.userPrompt}`,
  };
}

export interface ExtractPromptContext {
  projectName: string;
  existingOpenTaskTitles: string[];
  text: string;
}

export function extractPrompt(ctx: ExtractPromptContext) {
  const existingStr = ctx.existingOpenTaskTitles.length
    ? ctx.existingOpenTaskTitles.slice(0, 30).join("; ")
    : "none";
  return {
    system: `You are a project task extraction assistant. Extract actionable tasks from meeting notes or chat text. Avoid proposing tasks that already exist. These are SUGGESTIONS ONLY.`,
    user: `Project: "${ctx.projectName}"
Existing open tasks (do not duplicate): ${existingStr}
Text to analyze:\n${ctx.text}`,
  };
}

export interface AskPromptContext {
  projectName: string;
  evidence: string;
  question: string;
}

export function askPrompt(ctx: AskPromptContext) {
  return {
    system: `You are an AI project assistant. Answer questions about the project using ONLY the provided data.
Per-member ticket counts are included in the data under "Members:". When the question asks about a specific person, match their name case-insensitively and partially (e.g. "aditya" matches "Aditya Challa"), then answer precisely using their counts. If the name matches no member, say so explicitly and list the member names that are available.
If the data is insufficient to answer, acknowledge it and state low confidence.`,
    user: `Project: "${ctx.projectName}"
Current project data:\n${ctx.evidence}
Question: ${ctx.question}`,
  };
}
