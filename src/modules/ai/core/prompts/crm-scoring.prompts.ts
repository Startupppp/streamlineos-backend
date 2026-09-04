/**
 * Prompts that ask the model to JUDGE an existing CRM record — score a lead,
 * predict a deal, rank the next action, read churn risk. Every one returns a
 * structured verdict against a fixed rubric and is consumed by
 * `CrmScoringService`.
 *
 * They are kept apart from the content-generation prompts because the two move
 * for different reasons: a rubric changes when the sales model changes, a
 * copywriting instruction changes when the brand voice does.
 */

export interface LeadScoringInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  designation?: string | null;
  city?: string | null;
  source?: string | null;
  priority?: string | null;
  potentialValue?: string | null;
  investmentInterest?: string | null;
  notes?: string | null;
  tags?: string[] | null;
  daysSinceCreated: number;
  activityCount: number;
  hasAssignee: boolean;
}

export function leadScoringPrompt(lead: LeadScoringInput) {
  return {
    system: `You are an expert sales lead scoring analyst for an Indian investment/financial services company.
Score the lead from 0 to 100 based on:
- Contact completeness (name, email, phone, company): 0-15 points
- Financial signals (potentialValue, investmentInterest): 0-25 points
- Engagement signals (activityCount, daysSinceCreated, hasAssignee): 0-20 points
- Source quality (referral > website > campaign > cold_call > walk_in > other): 0-15 points
- Priority indicator (HOT > WARM > COLD): 0-10 points
- Company/designation presence (indicates serious buyer): 0-15 points

Return JSON with exactly these fields:
{
  "score": <number 0-100>,
  "reasoning": "<1-2 sentence explanation>",
  "strengths": ["<strength1>", "<strength2>"],
  "weaknesses": ["<weakness1>"],
  "suggestedActions": ["<action1>", "<action2>"]
}`,
    user: `Score this lead:
Name: ${lead.name}
Email: ${lead.email || "Not provided"}
Phone: ${lead.phone || "Not provided"}
Company: ${lead.company || "Not provided"}
Designation: ${lead.designation || "Not provided"}
City: ${lead.city || "Not provided"}
Source: ${lead.source || "unknown"}
Priority: ${lead.priority || "WARM"}
Potential Value: ${lead.potentialValue ? `₹${lead.potentialValue}` : "Not specified"}
Investment Interest: ${lead.investmentInterest ? `₹${lead.investmentInterest}` : "Not specified"}
Notes: ${lead.notes || "None"}
Tags: ${lead.tags?.length ? lead.tags.join(", ") : "None"}
Days since created: ${lead.daysSinceCreated}
Activities logged: ${lead.activityCount}
Has assignee: ${lead.hasAssignee ? "Yes" : "No"}`,
  };
}

export interface DealPredictionInput {
  dealName: string;
  value: number;
  stage: string;
  probability: number;
  daysInPipeline: number;
  daysInCurrentStage: number;
  activityCount: number;
  lastActivityDaysAgo: number | null;
  contactPerson?: string | null;
  assignedTo?: string | null;
  hasExpectedCloseDate: boolean;
  daysUntilExpectedClose: number | null;
  notes?: string | null;
}

export function dealPredictionPrompt(deal: DealPredictionInput) {
  return {
    system: `You are an expert sales deal analyst for an Indian investment/financial services company.
Predict the probability of winning this deal (0-100%) and provide analysis.

Consider these factors:
- Stage progression speed (fast = good)
- Activity frequency (regular engagement = good)
- Deal value vs stage (high value deals need more nurturing)
- Days without activity (stale = risk)
- Whether expected close date is set and how close it is
- Having a contact person and assigned rep (both = good)

Return JSON:
{
  "winProbability": <number 0-100>,
  "confidence": "<low|medium|high>",
  "reasoning": "<1-2 sentence explanation>",
  "riskFactors": ["<risk1>", "<risk2>"],
  "positiveSignals": ["<signal1>"],
  "recommendedActions": ["<action1>", "<action2>"]
}`,
    user: `Predict win probability for this deal:
Deal: ${deal.dealName}
Value: ₹${deal.value.toLocaleString("en-IN")}
Stage: ${deal.stage}
Current Probability: ${deal.probability}%
Days in Pipeline: ${deal.daysInPipeline}
Days in Current Stage: ${deal.daysInCurrentStage}
Total Activities: ${deal.activityCount}
Last Activity: ${deal.lastActivityDaysAgo !== null ? `${deal.lastActivityDaysAgo} days ago` : "None logged"}
Contact Person: ${deal.contactPerson || "Not set"}
Assigned To: ${deal.assignedTo || "Unassigned"}
Expected Close Date: ${deal.hasExpectedCloseDate ? (deal.daysUntilExpectedClose !== null ? `in ${deal.daysUntilExpectedClose} days` : "Set") : "Not set"}
Notes: ${deal.notes || "None"}`,
  };
}

export interface NextActionInput {
  entityType: "lead" | "deal";
  name: string;
  status: string;
  priority?: string | null;
  lastActivityType?: string | null;
  lastActivityDate?: string | null;
  daysSinceLastActivity: number | null;
  value?: number | null;
  assignedTo?: string | null;
  followUpDate?: string | null;
  isOverdueFollowUp: boolean;
  notes?: string | null;
}

export function nextActionPrompt(input: NextActionInput) {
  return {
    system: `You are a sales productivity advisor for an Indian investment/financial services company.
Suggest the ONE most impactful next action for this ${input.entityType}.

Consider:
- Stage/status: what action moves it forward?
- Recency: if stale (>7 days no activity), suggest re-engagement
- Follow-up: if overdue, make that the priority
- Value: higher value = more personal touch (call/meeting vs email)

Return JSON:
{
  "action": "<concise action description, max 10 words>",
  "urgency": "<low|medium|high|critical>",
  "reasoning": "<1 sentence why this action>",
  "template": "<optional: short message template if action is email/call>"
}`,
    user: `What should the sales rep do next for this ${input.entityType}?
Name: ${input.name}
Status: ${input.status}
${input.priority ? `Priority: ${input.priority}` : ""}
${input.value ? `Value: ₹${input.value.toLocaleString("en-IN")}` : ""}
Assigned To: ${input.assignedTo || "Unassigned"}
Last Activity: ${input.lastActivityType ? `${input.lastActivityType} (${input.daysSinceLastActivity ?? "?"} days ago)` : "No activity logged"}
Follow-up Date: ${input.followUpDate || "Not set"}${input.isOverdueFollowUp ? " (OVERDUE)" : ""}
Notes: ${input.notes || "None"}`,
  };
}

export interface ChurnRiskInput {
  clientName: string;
  company?: string | null;
  healthScore: number;
  investmentValue?: number | null;
  daysSinceLastActivity: number | null;
  openTickets: number;
  totalTicketsLast90Days: number;
  accountManagerName?: string | null;
  status: string;
  daysSinceConversion: number;
}

export function churnRiskPrompt(input: ChurnRiskInput) {
  return {
    system: `You are a customer success analyst for an Indian investment/financial services company.
Assess the churn risk for this client (0-100, where 100 = certain to churn).

Scoring factors:
- Activity recency: no activity >30 days = high risk
- Support ticket volume: increasing tickets = frustration signal
- Investment value: higher value clients need proactive retention
- Account age: newer clients (<90 days) are more volatile
- Health score: existing score provides baseline

Return JSON:
{
  "churnRiskScore": <number 0-100>,
  "riskLevel": "<low|medium|high|critical>",
  "reasoning": "<1-2 sentences>",
  "riskFactors": ["<factor1>", "<factor2>"],
  "retentionActions": ["<action1>", "<action2>"]
}`,
    user: `Assess churn risk for:
Client: ${input.clientName}${input.company ? ` (${input.company})` : ""}
Current Health Score: ${input.healthScore}/100
Investment Value: ${input.investmentValue ? `₹${input.investmentValue.toLocaleString("en-IN")}` : "Unknown"}
Last Activity: ${input.daysSinceLastActivity !== null ? `${input.daysSinceLastActivity} days ago` : "No activity recorded"}
Open Tickets: ${input.openTickets}
Tickets in Last 90 Days: ${input.totalTicketsLast90Days}
Account Manager: ${input.accountManagerName || "Unassigned"}
Status: ${input.status}
Client Since: ${input.daysSinceConversion} days ago`,
  };
}
