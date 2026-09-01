import { ConflictException, NotFoundException } from "@nestjs/common";
import { BlogAdminController } from "./blog-admin.controller";
import { BlogService } from "./blog.service";
import type {
  PostCreateInput,
  PostUpdateInput,
  CategoryCreateInput,
  CategoryUpdateInput,
} from "./dto/blog.schemas";

function makeMockService(): jest.Mocked<
  Pick<
    BlogService,
    | "listAdminPosts"
    | "getAdminPostById"
    | "createPost"
    | "updatePost"
    | "deletePost"
    | "createCategory"
    | "updateCategory"
    | "deleteCategory"
  >
> {
  return {
    listAdminPosts: jest.fn(),
    getAdminPostById: jest.fn(),
    createPost: jest.fn(),
    updatePost: jest.fn(),
    deletePost: jest.fn(),
    createCategory: jest.fn(),
    updateCategory: jest.fn(),
    deleteCategory: jest.fn(),
  };
}

describe("BlogAdminController", () => {
  let controller: BlogAdminController;
  let service: ReturnType<typeof makeMockService>;

  beforeEach(() => {
    service = makeMockService();
    controller = new BlogAdminController(service as unknown as BlogService);
  });

  afterEach(() => jest.resetAllMocks());

  describe("listPosts", () => {
    it("delegates to BlogService.listAdminPosts and returns the result", async () => {
      const posts = [{ id: "a", title: "Hello" }];
      service.listAdminPosts.mockResolvedValue(posts as never);

      const result = await controller.listPosts();

      expect(service.listAdminPosts).toHaveBeenCalledTimes(1);
      expect(result).toBe(posts);
    });
  });

  describe("getPost", () => {
    it("returns the post when found", async () => {
      const post = { id: "abc", title: "Test" };
      service.getAdminPostById.mockResolvedValue(post as never);

      const result = await controller.getPost("abc");

      expect(service.getAdminPostById).toHaveBeenCalledWith("abc");
      expect(result).toBe(post);
    });

    it("throws NotFoundException when the post does not exist", async () => {
      service.getAdminPostById.mockResolvedValue(undefined);

      await expect(controller.getPost("missing-id")).rejects.toThrow(NotFoundException);
    });
  });

  describe("createPost", () => {
    it("delegates to BlogService.createPost and returns the created post", async () => {
      const input: PostCreateInput = {
        title: "New Post",
        excerpt: "An excerpt",
        content: "Content body",
        coverImage: "https://example.com/img.jpg",
        status: "draft",
        isFeatured: false,
        tags: [],
      };
      const created = { id: "new-id", ...input };
      service.createPost.mockResolvedValue(created as never);

      const result = await controller.createPost(input);

      expect(service.createPost).toHaveBeenCalledWith(input);
      expect(result).toBe(created);
    });
  });

  describe("updatePost", () => {
    it("returns the updated post when found", async () => {
      const input: PostUpdateInput = { title: "Updated" };
      const updated = { id: "existing", title: "Updated" };
      service.updatePost.mockResolvedValue(updated as never);

      const result = await controller.updatePost("existing", input);

      expect(service.updatePost).toHaveBeenCalledWith("existing", input);
      expect(result).toBe(updated);
    });

    it("throws NotFoundException when the post does not exist", async () => {
      service.updatePost.mockResolvedValue(null);

      await expect(controller.updatePost("missing", { title: "X" })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("deletePost", () => {
    it("returns success when the post is deleted", async () => {
      service.deletePost.mockResolvedValue({ success: true });

      const result = await controller.deletePost("existing");

      expect(service.deletePost).toHaveBeenCalledWith("existing");
      expect(result).toEqual({ success: true });
    });

    it("throws NotFoundException when the post does not exist", async () => {
      service.deletePost.mockResolvedValue(null);

      await expect(controller.deletePost("missing")).rejects.toThrow(NotFoundException);
    });
  });

  describe("createCategory", () => {
    it("returns the created category on success", async () => {
      const input: CategoryCreateInput = { name: "Engineering" };
      const created = { id: "cat-1", name: "Engineering", slug: "engineering" };
      service.createCategory.mockResolvedValue(created as never);

      const result = await controller.createCategory(input);

      expect(service.createCategory).toHaveBeenCalledWith(input);
      expect(result).toBe(created);
    });

    it("throws ConflictException when the service returns a duplicate error", async () => {
      service.createCategory.mockResolvedValue({ error: "duplicate" as const });

      await expect(controller.createCategory({ name: "Duplicate" })).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe("updateCategory", () => {
    it("returns the updated category when found", async () => {
      const input: CategoryUpdateInput = { name: "Design" };
      const updated = { id: "cat-2", name: "Design", slug: "design" };
      service.updateCategory.mockResolvedValue(updated as never);

      const result = await controller.updateCategory("cat-2", input);

      expect(service.updateCategory).toHaveBeenCalledWith("cat-2", input);
      expect(result).toBe(updated);
    });

    it("throws NotFoundException when the category does not exist", async () => {
      service.updateCategory.mockResolvedValue(null);

      await expect(controller.updateCategory("missing", {})).rejects.toThrow(NotFoundException);
    });
  });

  describe("deleteCategory", () => {
    it("returns success when the category is deleted", async () => {
      service.deleteCategory.mockResolvedValue({ success: true });

      const result = await controller.deleteCategory("cat-3");

      expect(service.deleteCategory).toHaveBeenCalledWith("cat-3");
      expect(result).toEqual({ success: true });
    });

    it("throws NotFoundException when the category does not exist", async () => {
      service.deleteCategory.mockResolvedValue(null);

      await expect(controller.deleteCategory("missing")).rejects.toThrow(NotFoundException);
    });
  });
});
