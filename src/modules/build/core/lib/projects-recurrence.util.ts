import type { RecurrenceRuleInput } from "../dto/projects.schemas";

export function computeNextRunAt(rule: RecurrenceRuleInput, from: Date = new Date()): Date {
  const next = new Date(from);

  if (rule.frequency === "daily") {
    next.setDate(next.getDate() + rule.interval);
    return next;
  }

  if (rule.frequency === "monthly") {
    next.setMonth(next.getMonth() + rule.interval);
    return next;
  }

  if (rule.frequency === "weekly") {
    const days = rule.daysOfWeek;
    if (!days || days.length === 0) {
      next.setDate(next.getDate() + rule.interval * 7);
      return next;
    }

    const sortedDays = [...days].sort((a, b) => a - b);
    const currentDay = from.getDay();
    const nextDay = sortedDays.find((d) => d > currentDay);
    const firstDay = sortedDays[0] ?? 0;

    if (nextDay !== undefined) {
      next.setDate(next.getDate() + (nextDay - currentDay));
    } else {
      const daysUntilNextWeek = 7 - currentDay + firstDay;
      next.setDate(next.getDate() + daysUntilNextWeek + (rule.interval - 1) * 7);
    }
    return next;
  }

  next.setDate(next.getDate() + 7);
  return next;
}
