export function birthdaySubject(displayName: string): string {
  return `Happy Birthday, ${displayName}!`;
}

export function birthdayMessage(displayName: string): string {
  return `Today is ${displayName}'s birthday! Wish them a wonderful day!`;
}

export function resignationSubmittedTitle(): string {
  return "New Resignation Submitted";
}

export function resignationSubmittedMessage(employeeName: string): string {
  return `${employeeName} has submitted a resignation request.`;
}

export function resignationHrApprovedTitle(): string {
  return "Resignation Awaiting Your Approval";
}

export function resignationHrApprovedMessage(employeeName: string): string {
  return `${employeeName}'s resignation has been approved by HR and needs your final approval.`;
}

export function resignationCeoApprovedMessage(): string {
  return "Your resignation has been approved. Please ensure a smooth handover.";
}

export function resignationCeoRejectedMessage(): string {
  return "Your resignation request has been reviewed and rejected.";
}
