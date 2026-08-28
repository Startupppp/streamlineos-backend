import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { teamEventParticipants, teamEvents } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CreateTeamEventInput } from "./dto/hr-directory.schemas";
import { EmploymentFactsService } from "../../directory/employment-facts.service";

@Injectable()
export class TeamEventsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly employmentFacts: EmploymentFactsService,
  ) {}

  async list(orgId: string) {
    const rows = await this.db.query.teamEvents.findMany({
      where: eq(teamEvents.orgId, orgId),
      with: {
        participants: true,
        organizer: {
          columns: { id: true, name: true, email: true, image: true },
        },
      },
      orderBy: [desc(teamEvents.date)],
      limit: 500,
    });

    const facts = await this.employmentFacts.getFactsBatch(
      orgId,
      rows.map((row) => row.organizer?.id).filter((id): id is string => Boolean(id)),
    );

    return rows.map((row) => ({
      ...row,
      organizer: row.organizer
        ? {
            ...row.organizer,
            designation: facts.get(row.organizer.id)?.designation ?? null,
          }
        : row.organizer,
    }));
  }

  async create(orgId: string, userId: string, body: CreateTeamEventInput) {
    const rawDate = body.date ?? body.startDate ?? "";
    const eventDate = rawDate.includes("T") ? rawDate.split("T")[0] : rawDate;
    const eventTime = body.time ?? (rawDate.includes("T") ? rawDate.split("T")[1]?.slice(0, 5) : undefined);

    const [event] = await this.db
      .insert(teamEvents)
      .values({
        orgId,
        title: body.title,
        description: body.description,
        type: body.type,
        date: eventDate,
        time: eventTime,
        location: body.location,
        maxParticipants: body.maxParticipants,
        organizedBy: userId,
      })
      .returning();

    return event;
  }

  async joinEvent(orgId: string, userId: string, eventId: number) {
    if (!eventId) throw new BadRequestException("Invalid event ID.");

    const event = await this.db.query.teamEvents.findFirst({
      where: and(eq(teamEvents.id, eventId), eq(teamEvents.orgId, orgId)),
      with: { participants: true },
    });
    if (!event) throw new NotFoundException("Event not found.");

    const alreadyJoined = event.participants?.some((p) => p.userId === userId);
    if (alreadyJoined) throw new ConflictException("Already registered.");

    if (event.maxParticipants && (event.participants?.length ?? 0) >= event.maxParticipants) {
      throw new BadRequestException("Event is full.");
    }

    const [participant] = await this.db
      .insert(teamEventParticipants)
      .values({
        eventId,
        userId,
        status: "GOING",
      })
      .returning();

    return participant;
  }
}
