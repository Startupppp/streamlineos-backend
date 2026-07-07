import { Test, type TestingModule } from "@nestjs/testing";
import { SupportMentionsService } from "./support-mentions.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { NotificationsService } from "../notifications/notifications.service";

const mockDb = {
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  innerJoin: jest.fn().mockReturnThis(),
  where: jest.fn().mockResolvedValue([]),
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
};

const mockNotifications = {
  create: jest.fn().mockResolvedValue(undefined),
};

const ORG_USERS = [
  { id: "user-jane", name: "Jane Doe", firstName: "Jane", lastName: "Doe", email: "jane@example.com" },
  { id: "user-bob", name: null, firstName: "Bob", lastName: "Lee", email: "bob@example.com" },
  { id: "user-author", name: "Author Person", firstName: "Author", lastName: "Person", email: "author@example.com" },
];

describe("SupportMentionsService", () => {
  let service: SupportMentionsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.where.mockResolvedValue(ORG_USERS);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportMentionsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    }).compile();
    service = module.get(SupportMentionsService);
  });

  it("does nothing when the content has no '@' at all", async () => {
    await service.processMessageMentions({
      orgId: "org1",
      ticketId: 1,
      ticketTitle: "t",
      messageId: 1,
      content: "no mentions here",
      authorId: "user-author",
      authorName: "Author Person",
    });

    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockNotifications.create).not.toHaveBeenCalled();
  });

  it("matches a mention by first name and notifies that user", async () => {
    await service.processMessageMentions({
      orgId: "org1",
      ticketId: 1,
      ticketTitle: "Login issue",
      messageId: 5,
      content: "please take a look, cc @Jane",
      authorId: "user-author",
      authorName: "Author Person",
    });

    expect(mockDb.insert).toHaveBeenCalled();
    expect(mockDb.values).toHaveBeenCalledWith([
      { orgId: "org1", messageId: 5, mentionedUserId: "user-jane" },
    ]);
    expect(mockNotifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org1", userId: "user-jane", title: "You were mentioned" }),
    );
  });

  it("matches a mention by email local-part", async () => {
    await service.processMessageMentions({
      orgId: "org1",
      ticketId: 1,
      ticketTitle: "t",
      messageId: 5,
      content: "can you check this, @bob",
      authorId: "user-author",
      authorName: "Author Person",
    });

    expect(mockNotifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-bob" }),
    );
  });

  it("never notifies the author about their own mention", async () => {
    await service.processMessageMentions({
      orgId: "org1",
      ticketId: 1,
      ticketTitle: "t",
      messageId: 5,
      content: "noting this myself, @Author",
      authorId: "user-author",
      authorName: "Author Person",
    });

    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockNotifications.create).not.toHaveBeenCalled();
  });

  it("does nothing when the '@' token matches no org member", async () => {
    await service.processMessageMentions({
      orgId: "org1",
      ticketId: 1,
      ticketTitle: "t",
      messageId: 5,
      content: "@nobody-like-this",
      authorId: "user-author",
      authorName: "Author Person",
    });

    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockNotifications.create).not.toHaveBeenCalled();
  });
});
