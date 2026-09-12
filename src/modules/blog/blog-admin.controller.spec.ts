import { ConflictException, NotFoundException } from "@nestjs/common";
import { BlogAdminController } from "./blog-admin.controller";
import { BlogService } from "./blog.service";
import { BlogCategoriesService } from "./blog-categories.service";
import type {
  PostCreateInput,
  PostUpdateInput,
  CategoryCreateInput,
  CategoryUpdateInput,
} from "./dto/blog.schemas";

function makeMockPostService(): jest.Mocked<
  Pick<
    BlogService,
    | "listAdminPosts"
    | "getAdminPostById"
    | "createPost"
    | "updatePost"
    | "deletePost"
  >
> {
  return {
    listAdminPosts: jest.fn(),
    getAdminPostById: jest.fn(),
    createPost: jest.fn(),
    updatePost: jest.fn(),
    deletePost: jest.fn(),
  };
}

function makeMockCategoriesService(): jest.Mocked<
  Pick<
    BlogCategoriesService,
    | "getAdminCategories"
    | "createCategory"
    | "updateCategory"
    | "deleteCategory"
  >
> {
  return {
    getAdminCategories: jest.fn(),
    createCategory: jest.fn(),
    updateCategory: jest.fn(),
    deleteCategory: jest.fn(),
  };
}

describe("BlogAdminController", () => {
  let controller: BlogAdminController;
  let postService: ReturnType<typeof makeMockPostService>;
  let categoriesService: ReturnType<typeof makeMockCategoriesService>;

  beforeEach(() => {
    postService = makeMockPostService();
    categoriesService = makeMockCategoriesService();
    controller = new BlogAdminController(
      postService as unknown as BlogService,
      categoriesService as unknown as BlogCategoriesService,
    );
  });

  afterEach(() => jest.resetAllMocks());

  describe("listPosts", () => {
    it("delegates to BlogService.listAdminPosts and returns the result", async () => {
      const posts = [{ id: "a", title: "Hello" }];
      postService.listAdminPosts.mockResolvedValue(posts as never);

      const result = await controller.listPosts({ page: 1, limit: 20 });

      expect(postService.listAdminPosts).toHaveBeenCalledTimes(1);
      expect(result).toBe(posts);
    });
  });

  describe("getPost", () => {
    it("returns the post when found", async () => {
      const post = { id: "abc", title: "Test" };
      postService.getAdminPostById.mockResolvedValue(post as never);

      const result = await controller.getPost("abc");

      expect(postService.getAdminPostById).toHaveBeenCalledWith("abc");
      expect(result).toBe(post);
    });

    it("throws NotFoundException when the post does not exist", async () => {
      postService.getAdminPostById.mockResolvedValue(undefined);

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
      postService.createPost.mockResolvedValue(created as never);

      const result = await controller.createPost(input);

      expect(postService.createPost).toHaveBeenCalledWith(input);
      expect(result).toBe(created);
    });
  });

  describe("updatePost", () => {
    it("returns the updated post when found", async () => {
      const input: PostUpdateInput = { title: "Updated" };
      const updated = { id: "existing", title: "Updated" };
      postService.updatePost.mockResolvedValue(updated as never);

      const result = await controller.updatePost("existing", input);

      expect(postService.updatePost).toHaveBeenCalledWith("existing", input);
      expect(result).toBe(updated);
    });

    it("throws NotFoundException when the post does not exist", async () => {
      postService.updatePost.mockResolvedValue(null);

      await expect(controller.updatePost("missing", { title: "X" })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("deletePost", () => {
    it("returns success when the post is deleted", async () => {
      postService.deletePost.mockResolvedValue({ success: true });

      const result = await controller.deletePost("existing");

      expect(postService.deletePost).toHaveBeenCalledWith("existing");
      expect(result).toEqual({ success: true });
    });

    it("throws NotFoundException when the post does not exist", async () => {
      postService.deletePost.mockResolvedValue(null);

      await expect(controller.deletePost("missing")).rejects.toThrow(NotFoundException);
    });
  });

  describe("createCategory", () => {
    it("returns the created category on success", async () => {
      const input: CategoryCreateInput = { name: "Engineering" };
      const created = { id: "cat-1", name: "Engineering", slug: "engineering" };
      categoriesService.createCategory.mockResolvedValue(created as never);

      const result = await controller.createCategory(input);

      expect(categoriesService.createCategory).toHaveBeenCalledWith(input);
      expect(result).toBe(created);
    });

    it("throws ConflictException when the service returns a duplicate error", async () => {
      categoriesService.createCategory.mockResolvedValue({ error: "duplicate" as const });

      await expect(controller.createCategory({ name: "Duplicate" })).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe("updateCategory", () => {
    it("returns the updated category when found", async () => {
      const input: CategoryUpdateInput = { name: "Design" };
      const updated = { id: "cat-2", name: "Design", slug: "design" };
      categoriesService.updateCategory.mockResolvedValue(updated as never);

      const result = await controller.updateCategory("cat-2", input);

      expect(categoriesService.updateCategory).toHaveBeenCalledWith("cat-2", input);
      expect(result).toBe(updated);
    });

    it("throws NotFoundException when the category does not exist", async () => {
      categoriesService.updateCategory.mockResolvedValue(null);

      await expect(controller.updateCategory("missing", {})).rejects.toThrow(NotFoundException);
    });
  });

  describe("deleteCategory", () => {
    it("returns success when the category is deleted", async () => {
      categoriesService.deleteCategory.mockResolvedValue({ success: true });

      const result = await controller.deleteCategory("cat-3");

      expect(categoriesService.deleteCategory).toHaveBeenCalledWith("cat-3");
      expect(result).toEqual({ success: true });
    });

    it("throws NotFoundException when the category does not exist", async () => {
      categoriesService.deleteCategory.mockResolvedValue(null);

      await expect(controller.deleteCategory("missing")).rejects.toThrow(NotFoundException);
    });
  });
});
