import { addDays, formatDateOnly } from "../../../common/date";

export interface BurnupPoint {
  date: string;
  scope: number;
  completed: number;
}

interface CycleScopeEvent {
  ticketId: number;
  eventType: string;
  newPoints: number | null;
  createdAt: Date;
}

interface TicketState {
  points: number;
  inCycle: boolean;
  completed: boolean;
}

export function computeBurnupFromEvents(
  events: CycleScopeEvent[],
  startDate: Date,
  days: number,
): BurnupPoint[] {
  const state = new Map<number, TicketState>();
  let eventIndex = 0;

  return Array.from({ length: days }).map((_, dayIndex) => {
    const day = addDays(startDate, dayIndex);
    const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59, 999);

    while (eventIndex < events.length) {
      const event = events[eventIndex];
      if (!event || event.createdAt > dayEnd) break;
      const ticketState = state.get(event.ticketId) ?? {
        points: 0,
        inCycle: false,
        completed: false,
      };
      switch (event.eventType) {
        case "added":
          ticketState.inCycle = true;
          if (event.newPoints !== null) ticketState.points = event.newPoints;
          break;
        case "removed":
          ticketState.inCycle = false;
          break;
        case "estimate_changed":
          if (event.newPoints !== null) ticketState.points = event.newPoints;
          break;
        case "completed":
          ticketState.completed = true;
          break;
        case "reopened":
          ticketState.completed = false;
          break;
      }
      state.set(event.ticketId, ticketState);
      eventIndex++;
    }

    let scope = 0;
    let completed = 0;
    for (const ticketState of state.values()) {
      if (!ticketState.inCycle) continue;
      scope += ticketState.points;
      if (ticketState.completed) completed += ticketState.points;
    }

    return {
      date: formatDateOnly(day),
      scope,
      completed: Math.min(completed, scope),
    };
  });
}
