import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  DocumentIngestRequestDto,
  DocumentIngestResponseDto,
} from '@my-org/shared-types';
import { DocumentsService } from './documents.service';
import { Public } from '../auth/public.decorator';

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post()
  @HttpCode(201)
  @Public()
  async ingest(
    @Body() body: DocumentIngestRequestDto,
  ): Promise<DocumentIngestResponseDto> {
    return this.documentsService.ingest(body);
  }
}
