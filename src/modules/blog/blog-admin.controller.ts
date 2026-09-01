import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { BlogService } from "./blog.service";
import {
  postCreateSchema,
  postUpdateSchema,
  categoryCreateSchema,
  categoryUpdateSchema,
  type PostCreateInput,
  type PostUpdateInput,
  type CategoryCreateInput,
  type CategoryUpdateInput,
} from "./dto/blog.schemas";

const postIdParams = z.object({ postId: z.string().uuid() }).strict();
const categoryIdParams = z.object({ categoryId: z.string().uuid() }).strict();

@Controller("blog/admin")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BlogAdminController {
  constructor(private readonly blog: BlogService) {}

  @Get("posts")
  @RequirePermission("blog:posts:manage")
  listPosts() {
    return this.blog.listAdminPosts();
  }

  @Get("posts/:postId")
  @RequirePermission("blog:posts:manage")
  @Validate({ params: postIdParams })
  async getPost(@Param("postId") postId: string) {
    const post = await this.blog.getAdminPostById(postId);
    if (!post) throw new NotFoundException("Post not found");
    return post;
  }

  @Post("posts")
  @RequirePermission("blog:posts:manage")
  @Validate({ body: postCreateSchema })
  createPost(@Body() body: PostCreateInput) {
    return this.blog.createPost(body);
  }

  @Patch("posts/:postId")
  @RequirePermission("blog:posts:manage")
  @Validate({ params: postIdParams, body: postUpdateSchema })
  async updatePost(@Param("postId") postId: string, @Body() body: PostUpdateInput) {
    const updated = await this.blog.updatePost(postId, body);
    if (!updated) throw new NotFoundException("Post not found");
    return updated;
  }

  @Delete("posts/:postId")
  @RequirePermission("blog:posts:manage")
  @Validate({ params: postIdParams })
  async deletePost(@Param("postId") postId: string) {
    const result = await this.blog.deletePost(postId);
    if (!result) throw new NotFoundException("Post not found");
    return result;
  }

  @Post("categories")
  @RequirePermission("blog:categories:manage")
  @Validate({ body: categoryCreateSchema })
  async createCategory(@Body() body: CategoryCreateInput) {
    const result = await this.blog.createCategory(body);
    if ("error" in result && result.error === "duplicate")
      throw new ConflictException("A category with that name already exists");
    return result;
  }

  @Patch("categories/:categoryId")
  @RequirePermission("blog:categories:manage")
  @Validate({ params: categoryIdParams, body: categoryUpdateSchema })
  async updateCategory(
    @Param("categoryId") categoryId: string,
    @Body() body: CategoryUpdateInput,
  ) {
    const updated = await this.blog.updateCategory(categoryId, body);
    if (!updated) throw new NotFoundException("Category not found");
    return updated;
  }

  @Delete("categories/:categoryId")
  @RequirePermission("blog:categories:manage")
  @Validate({ params: categoryIdParams })
  async deleteCategory(@Param("categoryId") categoryId: string) {
    const result = await this.blog.deleteCategory(categoryId);
    if (!result) throw new NotFoundException("Category not found");
    return result;
  }
}
