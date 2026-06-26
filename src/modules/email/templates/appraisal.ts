import { getEmailTemplate, escapeHtml } from "./base";

export function getSelfReviewReminderEmail(
  employeeName: string,
  reviewCycle: string,
  dueDate: string,
  reviewUrl: string
): string {
  const sName = escapeHtml(employeeName);
  const sCycle = escapeHtml(reviewCycle);
  const content = `
    <h2 class="email-title">📝 Self-Review Reminder</h2>
    <p class="email-text">Hi <strong>${sName}</strong>,</p>
    <p class="email-text">
      Your self-review for <strong>${sCycle}</strong> is due on <strong>${dueDate}</strong>.
      Please take a few moments to reflect on your achievements, growth areas, and goals.
    </p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${reviewUrl}" class="email-button">Start Self-Review</a>
    </div>
    <p class="email-text" style="font-size:13px;color:#64748b;">
      This review helps your manager understand your perspective and ensure a fair evaluation.
    </p>
  `;
  return getEmailTemplate({
    title: `Self-Review Due: ${reviewCycle}`,
    preheader: `Your ${reviewCycle} self-review is due on ${dueDate}`,
    content,
  });
}

export function getManagerReviewReminderEmail(
  managerName: string,
  pendingCount: number,
  reviewCycle: string,
  reviewUrl: string
): string {
  const sName = escapeHtml(managerName);
  const sCycle = escapeHtml(reviewCycle);
  const content = `
    <h2 class="email-title">📋 Pending Reviews Reminder</h2>
    <p class="email-text">Hi <strong>${sName}</strong>,</p>
    <p class="email-text">
      You have <strong>${pendingCount} pending review${pendingCount > 1 ? "s" : ""}</strong> to complete for the <strong>${sCycle}</strong> performance cycle.
    </p>
    <p class="email-text">
      Timely reviews help your team members receive constructive feedback and plan their growth effectively.
    </p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${reviewUrl}" class="email-button">Complete Reviews</a>
    </div>
  `;
  return getEmailTemplate({
    title: `${pendingCount} Pending Reviews — ${reviewCycle}`,
    preheader: `You have ${pendingCount} pending performance reviews to complete`,
    content,
  });
}

export function getReviewPublishedEmail(
  employeeName: string,
  reviewCycle: string,
  overallRating: string,
  reviewUrl: string
): string {
  const sName = escapeHtml(employeeName);
  const sCycle = escapeHtml(reviewCycle);
  const sRating = escapeHtml(overallRating);
  const content = `
    <h2 class="email-title">🎯 Your Performance Review is Ready</h2>
    <p class="email-text">Hi <strong>${sName}</strong>,</p>
    <p class="email-text">
      Your performance review for <strong>${sCycle}</strong> has been published.
    </p>
    <div class="credential-box">
      <div class="credential-item">
        <span class="credential-label">Review Cycle:</span>
        <span class="credential-value">${sCycle}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Overall Rating:</span>
        <span class="credential-value">${sRating}</span>
      </div>
    </div>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${reviewUrl}" class="email-button">View My Review</a>
    </div>
  `;
  return getEmailTemplate({
    title: `Your ${reviewCycle} Review is Published`,
    preheader: `Your performance review is now available to view`,
    content,
  });
}

export function getGoalSettingReminderEmail(
  employeeName: string,
  quarter: string,
  dueDate: string,
  goalsUrl: string
): string {
  const sName = escapeHtml(employeeName);
  const sQuarter = escapeHtml(quarter);
  const content = `
    <h2 class="email-title">🎯 Set Your ${sQuarter} Goals</h2>
    <p class="email-text">Hi <strong>${sName}</strong>,</p>
    <p class="email-text">
      It's time to set your goals for <strong>${sQuarter}</strong>. Please submit your goals by <strong>${dueDate}</strong>.
    </p>
    <p class="email-text">
      Clear goals help align your work with team objectives and ensure a productive quarter.
    </p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${goalsUrl}" class="email-button">Set My Goals</a>
    </div>
  `;
  return getEmailTemplate({
    title: `Set Your ${quarter} Goals`,
    preheader: `Goal setting for ${quarter} is open — deadline: ${dueDate}`,
    content,
  });
}
