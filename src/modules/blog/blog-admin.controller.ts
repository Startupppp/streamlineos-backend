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
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { BlogService } from "./blog.service";
import { BlogCategoriesService } from "./blog-categories.service";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { itemsPagedSchema } from "../../common/openapi/response-envelopes";
import {
  blogPostWithRelationsSchema,
  blogPostSchema,
  blogDeleteSchema,
  blogAdminCategoryListSchema,
  blogCategorySchema,
} from "./dto/blog-response.schemas";
import {
  postCreateSchema,
  postUpdateSchema,
  categoryCreateSchema,
  categoryUpdateSchema,
  adminPostListQuerySchema,
  type PostCreateInput,
  type PostUpdateInput,
  type CategoryCreateInput,
  type CategoryUpdateInput,
  type AdminPostListQuery,
} from "./dto/blog.schemas";

const postIdParams = z.object({ postId: z.string().uuid() }).strict();
const categoryIdParams = z.object({ categoryId: z.string().uuid() }).strict();

@Controller("blog/admin")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BlogAdminController {
  constructor(
    private readonly blog: BlogService,
    private readonly categories: BlogCategoriesService,
  ) {}

  @Get("posts")
  @RequirePermission("blog:posts:manage")
  @Validate({ query: adminPostListQuerySchema })
  @ResponseSchema(itemsPagedSchema(blogPostWithRelationsSchema))
  listPosts(@Query() query: AdminPostListQuery) {
    return this.blog.listAdminPosts(query);
  }

  @Get("posts/:postId")
  @RequirePermission("blog:posts:manage")
  @Validate({ params: postIdParams })
  @ResponseSchema(blogPostWithRelationsSchema)
  async getPost(@Param("postId") postId: string) {
    const post = await this.blog.getAdminPostById(postId);
    if (!post) throw new NotFoundException("Post not found");
    return post;
  }

  @Post("posts")
  @RequirePermission("blog:posts:manage")
  @Validate({ body: postCreateSchema })
  @ResponseSchema(blogPostSchema)
  createPost(@Body() body: PostCreateInput) {
    return this.blog.createPost(body);
  }

  @Patch("posts/:postId")
  @RequirePermission("blog:posts:manage")
  @Validate({ params: postIdParams, body: postUpdateSchema })
  @ResponseSchema(blogPostSchema)
  async updatePost(@Param("postId") postId: string, @Body() body: PostUpdateInput) {
    const updated = await this.blog.updatePost(postId, body);
    if (!updated) throw new NotFoundException("Post not found");
    return updated;
  }

  @Delete("posts/:postId")
  @RequirePermission("blog:posts:manage")
  @Validate({ params: postIdParams })
  @ResponseSchema(blogDeleteSchema)
  async deletePost(@Param("postId") postId: string) {
    const result = await this.blog.deletePost(postId);
    if (!result) throw new NotFoundException("Post not found");
    return result;
  }

  @Get("categories")
  @RequirePermission("blog:categories:manage")
  @ResponseSchema(blogAdminCategoryListSchema)
  listCategories() {
    return this.categories.getAdminCategories();
  }

  @Post("categories")
  @RequirePermission("blog:categories:manage")
  @Validate({ body: categoryCreateSchema })
  @ResponseSchema(blogCategorySchema)
  async createCategory(@Body() body: CategoryCreateInput) {
    const result = await this.categories.createCategory(body);
    if ("error" in result && result.error === "duplicate")
      throw new ConflictException("A category with that name already exists");
    return result;
  }

  @Patch("categories/:categoryId")
  @RequirePermission("blog:categories:manage")
  @Validate({ params: categoryIdParams, body: categoryUpdateSchema })
  @ResponseSchema(blogCategorySchema)
  async updateCategory(
    @Param("categoryId") categoryId: string,
    @Body() body: CategoryUpdateInput,
  ) {
    const updated = await this.categories.updateCategory(categoryId, body);
    if (!updated) throw new NotFoundException("Category not found");
    return updated;
  }

  @Delete("categories/:categoryId")
  @RequirePermission("blog:categories:manage")
  @Validate({ params: categoryIdParams })
  @ResponseSchema(blogDeleteSchema)
  async deleteCategory(@Param("categoryId") categoryId: string) {
    const result = await this.categories.deleteCategory(categoryId);
    if (!result) throw new NotFoundException("Category not found");
    return result;
  }
}
