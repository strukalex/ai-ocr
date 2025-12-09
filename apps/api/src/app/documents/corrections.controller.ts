import { Controller, Get, Param, ValidationPipe } from '@nestjs/common';
import { CorrectionsService, CorrectionLogDto } from './corrections.service';

@Controller('documents/:documentId/corrections')
export class CorrectionsController {
  constructor(private readonly corrections: CorrectionsService) {}

  @Get()
  async listCorrections(
    @Param('documentId', new ValidationPipe({ transform: true }))
    documentId: string,
  ): Promise<CorrectionLogDto[]> {
    return this.corrections.listByDocument(documentId);
  }
}

