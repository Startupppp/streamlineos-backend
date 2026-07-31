export interface CandidateScoringInput {
  firstName: string;
  lastName: string;
  email: string;
  currentCompany?: string | null;
  currentRole?: string | null;
  experienceYears?: string | number | null;
  skills?: string[] | null;
  source?: string | null;
  notes?: string | null;
  jobTitle?: string | null;
  jobDescription?: string | null;
  jobRequiredSkills?: string[] | null;
}

export function candidateScoringPrompt(input: CandidateScoringInput) {
  return {
    system: `You are an expert HR recruiter scoring candidates for an Indian company.
Score the candidate from 0-100 based on:
- Experience match (0-25): years of experience vs role requirements
- Skill match (0-30): how well their skills align with required skills
- Company background (0-15): quality of current/previous companies
- Role progression (0-15): is their current role a good stepping stone for this position?
- Profile completeness (0-15): contact info, resume, portfolio, LinkedIn

Return JSON:
{
  "score": <number 0-100>,
  "fitLevel": "<excellent|good|average|poor>",
  "reasoning": "<1-2 sentences>",
  "strengths": ["<strength1>", "<strength2>"],
  "concerns": ["<concern1>"],
  "suggestedQuestions": ["<question1>", "<question2>", "<question3>"]
}`,
    user: `Score this candidate:
Name: ${input.firstName} ${input.lastName}
Email: ${input.email}
Current Company: ${input.currentCompany || "Not specified"}
Current Role: ${input.currentRole || "Not specified"}
Experience: ${input.experienceYears ? `${input.experienceYears} years` : "Unknown"}
Skills: ${input.skills?.length ? input.skills.join(", ") : "Not listed"}
Source: ${input.source || "Direct"}
Notes: ${input.notes || "None"}
${input.jobTitle ? `\nApplying for: ${input.jobTitle}` : ""}
${input.jobDescription ? `Job Description: ${input.jobDescription}` : ""}
${input.jobRequiredSkills?.length ? `Required Skills: ${input.jobRequiredSkills.join(", ")}` : ""}`,
  };
}

export interface ReviewDraftInput {
  employeeName: string;
  role?: string | null;
  department?: string | null;
  periodStart: string;
  periodEnd: string;
  goals?: { goal: string; achieved?: boolean; progress?: number }[] | null;
  recentActivities?: string[] | null;
  attendanceRate?: number | null;
  managerNotes?: string | null;
}

export function reviewDraftPrompt(input: ReviewDraftInput) {
  return {
    system: `You are an HR expert drafting balanced performance reviews for an Indian company.
Generate a constructive, specific, and actionable review.

Rating scale: 1-5 (1=needs improvement, 5=exceptional)

Categories to rate:
- Job Knowledge & Skills
- Quality of Work
- Productivity & Output
- Communication & Teamwork
- Initiative & Ownership

Return JSON:
{
  "overallRating": <number 1-5>,
  "strengths": "<2-3 sentences highlighting top strengths>",
  "improvements": "<2-3 sentences on areas for growth, framed constructively>",
  "comments": "<1-2 sentences overall summary>",
  "ratings": [
    { "category": "Job Knowledge & Skills", "score": <1-5>, "comment": "<brief>" },
    { "category": "Quality of Work", "score": <1-5>, "comment": "<brief>" },
    { "category": "Productivity & Output", "score": <1-5>, "comment": "<brief>" },
    { "category": "Communication & Teamwork", "score": <1-5>, "comment": "<brief>" },
    { "category": "Initiative & Ownership", "score": <1-5>, "comment": "<brief>" }
  ]
}`,
    user: `Draft a performance review for:
Employee: ${input.employeeName}
Role: ${input.role || "Not specified"}
Department: ${input.department || "Not specified"}
Period: ${input.periodStart} to ${input.periodEnd}

Goals during this period:
${input.goals?.length
      ? input.goals.map((g) => `- ${g.goal} (${g.achieved ? "✓ Achieved" : `${g.progress ?? 0}% complete`})`).join("\n")
      : "No goals tracked"}

Recent activities:
${input.recentActivities?.length ? input.recentActivities.map((a) => `- ${a}`).join("\n") : "None logged"}

${input.attendanceRate !== null && input.attendanceRate !== undefined ? `Attendance Rate: ${input.attendanceRate}%` : ""}
${input.managerNotes ? `\nManager Notes: ${input.managerNotes}` : ""}`,
  };
}

export interface HelpdeskReplyInput {
  ticketTitle: string;
  ticketDescription?: string | null;
  category?: string | null;
  priority?: string | null;
  employeeName?: string | null;
}

export function helpdeskReplyPrompt(input: HelpdeskReplyInput) {
  return {
    system: `You are an empathetic HR support agent for an Indian company.
Generate a professional, helpful reply to an employee helpdesk ticket.

Rules:
- Be warm and empathetic but professional
- Acknowledge the employee's concern
- Provide concrete next steps
- Use simple, clear language
- Maximum 100 words for the reply

Return JSON:
{
  "suggestedReply": "<professional reply text>",
  "category": "<inferred category: Leave / Payroll / IT / Benefits / Policy / Other>",
  "estimatedResolutionTime": "<e.g. 24 hours, 2-3 business days>",
  "followUpActions": ["<action1>", "<action2>"]
}`,
    user: `Generate a reply for this helpdesk ticket:
Title: ${input.ticketTitle}
Description: ${input.ticketDescription || "No description"}
Category: ${input.category || "Uncategorized"}
Priority: ${input.priority || "MEDIUM"}
Employee: ${input.employeeName || "Anonymous"}`,
  };
}

export interface AttritionRiskInput {
  employeeName: string;
  role?: string | null;
  department?: string | null;
  tenureMonths: number;
  attendanceRate?: number | null;
  recentLeaveDays?: number | null;
  openTickets?: number | null;
  lastReviewRating?: number | null;
  lastPromotionMonths?: number | null;
  hasGoals?: boolean;
}

export function attritionRiskPrompt(input: AttritionRiskInput) {
  return {
    system: `You are an HR analytics expert assessing employee attrition risk for an Indian company.
Score the attrition risk 0-100 (100 = very likely to leave).

Risk factors to consider:
- Low attendance rate (<85%) = increasing disengagement
- High recent leave usage = potentially job hunting
- Many open helpdesk tickets = unresolved frustrations
- Low last review rating (<3/5) = performance gap or dissatisfaction
- Long time since last promotion (>24 months) = stagnation risk
- No goals set = lack of direction
- New employees (<3 months) are higher risk
- Senior employees (>3 years) without recent recognition

Return JSON:
{
  "attritionRiskScore": <number 0-100>,
  "riskLevel": "<low|medium|high|critical>",
  "reasoning": "<1-2 sentences>",
  "riskFactors": ["<factor1>", "<factor2>"],
  "retentionActions": ["<action1>", "<action2>", "<action3>"]
}`,
    user: `Assess attrition risk for:
Employee: ${input.employeeName}
Role: ${input.role || "Not specified"}
Department: ${input.department || "Not specified"}
Tenure: ${input.tenureMonths} months
Attendance Rate: ${input.attendanceRate !== null && input.attendanceRate !== undefined ? `${input.attendanceRate}%` : "Unknown"}
Recent Leave Days (last 90d): ${input.recentLeaveDays ?? "Unknown"}
Open Helpdesk Tickets: ${input.openTickets ?? 0}
Last Performance Review Rating: ${input.lastReviewRating ? `${input.lastReviewRating}/5` : "No recent review"}
Months Since Last Promotion: ${input.lastPromotionMonths ?? "Never promoted"}
Has Active Goals: ${input.hasGoals ? "Yes" : "No"}`,
  };
}

export interface PolicyQaPromptInput {
  question: string;
  policies: Array<{ id: number; policyType: string; scopeType: string | null; name?: string | null; content?: string | null }>;
}

export function policyQaPrompt(input: PolicyQaPromptInput) {
  const policyList = input.policies
    .map((p) => `[Policy: ${p.id}] Type: ${p.policyType} | Scope: ${p.scopeType ?? "org"} | Name: ${p.name ?? "Unnamed"}${p.content ? `\nContent: ${p.content.slice(0, 600)}` : ""}`)
    .join("\n\n");
  return {
    system: `You are an expert HR policy assistant. Answer the employee's question strictly from the provided policies.
Cite each policy used inline as [Policy: <id>]. State your confidence level. If no policy confidently answers the question, say so explicitly — never invent policy rules.
Return JSON: { "answer": string, "confidence": "high"|"medium"|"low"|"not_found", "citations": [{ "policyType": string, "policyId": number, "snippet": string }], "shouldEscalate": boolean, "escalationReason"?: string }`,
    user: `Question: ${input.question}\n\nAvailable policies:\n${policyList || "No policies found."}`,
  };
}

export interface InterviewKitPromptInput {
  jobTitle: string;
  jobDescription: string | null;
  requirements: string | null;
  roundTypes?: string[] | null;
}

export function interviewKitPrompt(input: InterviewKitPromptInput) {
  return {
    system: `You are an expert technical interviewer. Draft a structured interview kit. This is a draft only for human review.
Return JSON: { "roundKits": [{ "round": string, "questions": [{ "question": string, "category": string, "expectedAnswer": string, "redFlags": string[] }], "rubric": [{ "criterion": string, "weight": number, "description": string }] }] }`,
    user: `Job Title: ${input.jobTitle}
Description: ${input.jobDescription?.slice(0, 1000) ?? "Not provided"}
Requirements: ${input.requirements?.slice(0, 500) ?? "Not provided"}
${input.roundTypes?.length ? `Interview Rounds: ${input.roundTypes.join(", ")}` : ""}`,
  };
}

export interface LetterDraftPromptInput {
  letterType: string;
  employeeName: string;
  currentTitle: string | null;
  details: string | null;
}

export function letterDraftPrompt(input: LetterDraftPromptInput) {
  return {
    system: `You are an HR professional drafting formal employment letters. This is a draft only — it requires human review and authorized signature before any official use.
Write in a professional tone across 3-4 paragraphs.
Return JSON: { "subject": string, "body": string, "disclaimer": string }`,
    user: `Letter Type: ${input.letterType}
Employee Name: ${input.employeeName}
Current Title: ${input.currentTitle ?? "Not specified"}
Additional Details: ${input.details ?? "None"}`,
  };
}

export interface InterviewNotesSummaryPromptInput {
  candidateName: string;
  jobTitle: string | null;
  rounds: Array<{ roundType: string; feedback: string | null; notes: string | null; rating: number | null; result: string }>;
}

export function interviewNotesSummaryPrompt(input: InterviewNotesSummaryPromptInput) {
  const roundsText = input.rounds
    .map((r, i) => `Round ${i + 1} (${r.roundType}) — Result: ${r.result} | Rating: ${r.rating ?? "N/A"}\nFeedback: ${r.feedback ?? "None"}\nNotes: ${r.notes ?? "None"}`)
    .join("\n\n");
  return {
    system: `You are an expert recruiter summarizing interview notes into a structured hiring brief.
Return JSON: { "overallRecommendation": string, "confidence": "low"|"medium"|"high", "strengthsSummary": string, "concernsSummary": string, "roundSummaries": [{ "round": string, "verdict": string, "keyPoints": string[] }], "suggestedNextStep": string }`,
    user: `Candidate: ${input.candidateName}
Role: ${input.jobTitle ?? "Not specified"}

Interview Rounds:\n${roundsText || "No rounds provided."}`,
  };
}
