import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  DocumentIngestRequestDto,
  DocumentIngestResponseDto,
} from '@my-org/shared-types';
import { DocumentsService } from './documents.service';

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post()
  @HttpCode(201)
  async ingest(
    @Body() body: DocumentIngestRequestDto,
  ): Promise<DocumentIngestResponseDto> {
    return this.documentsService.ingest(body);
  }
}
