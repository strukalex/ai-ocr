import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import {
  IntakeSourceCreateRequestDto,
  IntakeSourceDto,
  IntakeSourceUpdateRequestDto,
} from '@my-org/shared-types';
import { Roles } from '../auth/roles.decorator';
import { IntakeSourcesService } from './intake-sources.service';

@Controller('intake/sources')
export class IntakeSourcesController {
  constructor(private readonly intakeSources: IntakeSourcesService) {}

  @Get()
  @Roles('operator', 'admin')
  async list(): Promise<IntakeSourceDto[]> {
    return this.intakeSources.list();
  }

  @Post()
  @HttpCode(201)
  @Roles('operator', 'admin')
  async create(
    @Body(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: IntakeSourceCreateRequestDto,
  ): Promise<IntakeSourceDto> {
    return this.intakeSources.create(body);
  }

  @Patch(':sourceId')
  @Roles('operator', 'admin')
  async update(
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
    @Body(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: IntakeSourceUpdateRequestDto,
  ): Promise<IntakeSourceDto> {
    return this.intakeSources.update(sourceId, body);
  }

  @Delete(':sourceId')
  @HttpCode(204)
  @Roles('operator', 'admin')
  async disable(@Param('sourceId', new ParseUUIDPipe()) sourceId: string): Promise<void> {
    await this.intakeSources.disable(sourceId);
  }
}
