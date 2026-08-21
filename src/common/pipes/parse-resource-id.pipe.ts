import {
  BadRequestException,
  Injectable,
  NotFoundException,
  type PipeTransform,
} from "@nestjs/common";

const NUMERIC = /^\d+$/;

@Injectable()
export class ParseResourceIdPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    if (!NUMERIC.test(value)) throw new NotFoundException("Not found");
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1)
      throw new BadRequestException("Invalid resource id");
    return id;
  }
}
