import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import {
  DocumentIngestRequestDto,
  DocumentIngestResponseDto,
} from '@my-org/shared-types';
import { DocumentsService } from './documents.service';
import { Request } from 'express';
import { UserContext } from '@my-org/shared-types';

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post()
  @HttpCode(201)
  async ingest(
    @Req() req: Request & { user?: UserContext },
    @Body() body: DocumentIngestRequestDto,
  ): Promise<DocumentIngestResponseDto> {
    const traceIdFromInterceptor = (req as any).traceId;
    return this.documentsService.ingest(body, req.user?.userId, traceIdFromInterceptor);
  }
}
