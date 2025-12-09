import { Injectable } from '@nestjs/common';
import { PrismaService } from '@my-org/database';
import { CorrectionLog } from '@prisma/client';

export interface CorrectionLogDto {
  id: string;
  documentId: string;
  documentType?: string | null;
  fieldPath: string;
  previousValue?: string | null;
  correctedValue?: string | null;
  confidence?: number | null;
  reasonCode?: string | null;
  validatorId?: string | null;
  createdAt: string;
}

@Injectable()
export class CorrectionsService {
  constructor(private readonly prisma: PrismaService) {}

  async listByDocument(documentId: string): Promise<CorrectionLogDto[]> {
    const rows: CorrectionLog[] = await this.prisma.correctionLog.findMany({
      where: { documentId },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((row) => ({
      id: row.id,
      documentId: row.documentId,
      documentType: row.documentType,
      fieldPath: row.fieldPath,
      previousValue: row.previousValue,
      correctedValue: row.correctedValue,
      confidence: row.confidence,
      reasonCode: row.reasonCode,
      validatorId: row.validatorId,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}

