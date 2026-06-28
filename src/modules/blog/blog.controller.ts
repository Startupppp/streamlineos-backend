import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Public } from "../../common/auth/public.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { BlogService, isDuplicateCategory } from "./blog.service";
import {
  categoryCreateSchema,
  categoryUpdateSchema,
  feedSchema,
  postCreateSchema,
  postUpdateSchema,
  type CategoryCreateInput,
  type CategoryUpdateInput,
  type FeedInput,
  type PostCreateInput,
  type PostUpdateInput,
} from "./dto/blog.schemas";

@Controller("blog")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BlogController {
  constructor(private readonly blog: BlogService) {}

  @Get("posts")
  @RequirePermission("blog:posts:manage")
  listPosts() {
    return this.blog.listAdminPosts();
  }

  @Post("posts")
  @RequirePermission("blog:posts:manage")
  @HttpCode(201)
  createPost(
    @Body(new ZodValidationPipe(postCreateSchema)) body: PostCreateInput,
  ) {
    return this.blog.createPost(body);
  }

  @Get("posts/:postId")
  @RequirePermission("blog:posts:manage")
  async getPost(@Param("postId") postId: string) {
    const post = await this.blog.getAdminPostById(postId);
    if (!post) throw new NotFoundException("Post not found");
    return post;
  }

  @Patch("posts/:postId")
  @RequirePermission("blog:posts:manage")
  async updatePost(
    @Param("postId") postId: string,
    @Body(new ZodValidationPipe(postUpdateSchema)) body: PostUpdateInput,
  ) {
    const updated = await this.blog.updatePost(postId, body);
    if (!updated) throw new NotFoundException("Post not found");
    return updated;
  }

  @Delete("posts/:postId")
  @RequirePermission("blog:posts:manage")
  async deletePost(@Param("postId") postId: string) {
    const deleted = await this.blog.deletePost(postId);
    if (!deleted) throw new NotFoundException("Post not found");
    return deleted;
  }

  @Public()
  @Get("by-slug/:slug")
  async getPostBySlug(@Param("slug") slug: string) {
    const post = await this.blog.getPublishedPostBySlug(slug);
    if (!post) throw new NotFoundException("Post not found");
    return post;
  }

  @Public()
  @Get("by-slug/:slug/adjacent")
  getAdjacentPosts(@Param("slug") slug: string) {
    return this.blog.getAdjacentPosts(slug);
  }

  @Public()
  @Get("categories")
  listCategories() {
    return this.blog.getCategories();
  }

  @Post("categories")
  @RequirePermission("blog:categories:manage")
  @HttpCode(201)
  async createCategory(
    @Body(new ZodValidationPipe(categoryCreateSchema)) body: CategoryCreateInput,
  ) {
    const result = await this.blog.createCategory(body);
    if (isDuplicateCategory(result)) {
      throw new ConflictException("A category with that name already exists");
    }
    return result;
  }

  @Patch("categories/:categoryId")
  @RequirePermission("blog:categories:manage")
  async updateCategory(
    @Param("categoryId") categoryId: string,
    @Body(new ZodValidationPipe(categoryUpdateSchema)) body: CategoryUpdateInput,
  ) {
    const updated = await this.blog.updateCategory(categoryId, body);
    if (!updated) throw new NotFoundException("Category not found");
    return updated;
  }

  @Delete("categories/:categoryId")
  @RequirePermission("blog:categories:manage")
  async deleteCategory(@Param("categoryId") categoryId: string) {
    const deleted = await this.blog.deleteCategory(categoryId);
    if (!deleted) throw new NotFoundException("Category not found");
    return deleted;
  }

  @Public()
  @Get("feed")
  feed(@Query(new ZodValidationPipe(feedSchema)) query: FeedInput) {
    return this.blog.getPublishedPosts(query);
  }
}
