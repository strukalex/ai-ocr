import { Injectable } from '@nestjs/common';
import { Prisma, CorrectionLog } from '@prisma/client';
import { PrismaService } from '@my-org/database';
import { AuditLogger, LoggerService } from '@my-org/observability';
import { randomUUID } from 'crypto';
import { CorrectionsSummaryQueryDto } from './dto/corrections-summary-query.dto';
import { RetrainTriggerDto } from './dto/retrain-trigger.dto';

export interface CorrectionAggregateDto {
  documentType?: string | null;
  fieldPath: string;
  occurrences: number;
  latestCorrectionAt?: string | null;
  windowOccurrences: number;
  windowSince?: string | null;
  windowApplied: boolean;
  trackedNotEnforced: boolean;
}

export interface RetrainTriggerResponseDto {
  jobId: string;
  documentType: string;
  minCorrections: number;
  dryRun: boolean;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: string;
}

@Injectable()
export class LearningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogger,
    private readonly logger: LoggerService,
  ) {}

  async getCorrectionSummary(
    filters: CorrectionsSummaryQueryDto,
  ): Promise<CorrectionAggregateDto[]> {
    const baseWhere: Prisma.CorrectionLogWhereInput = {};
    if (filters.documentType) {
      baseWhere.documentType = filters.documentType;
    }
    if (filters.fieldPath) {
      baseWhere.fieldPath = filters.fieldPath;
    }

    const windowSince =
      filters.since !== undefined ? new Date(filters.since) : undefined;
    const windowWhere: Prisma.CorrectionLogWhereInput = {
      ...baseWhere,
      ...(windowSince ? { createdAt: { gte: windowSince } } : {}),
    };

    const [allTime, windowed] = await Promise.all([
      this.prisma.correctionLog.groupBy({
        by: ['documentType', 'fieldPath'],
        where: baseWhere,
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      this.prisma.correctionLog.groupBy({
        by: ['documentType', 'fieldPath'],
        where: windowWhere,
        _count: { _all: true },
        _max: { createdAt: true },
      }),
    ]);

    const windowKey = (row: { documentType: string | null; fieldPath: string }) =>
      `${row.documentType ?? '___'}::${row.fieldPath}`;

    const windowMap = new Map<string, (typeof windowed)[number]>();
    windowed.forEach((row) => windowMap.set(windowKey(row), row));

    return allTime.map((row) => {
      const key = windowKey(row);
      const windowRow = windowMap.get(key);

      return {
        documentType: row.documentType,
        fieldPath: row.fieldPath,
        occurrences: row._count._all,
        latestCorrectionAt: row._max.createdAt?.toISOString() ?? null,
        windowOccurrences: windowRow?._count._all ?? 0,
        windowSince: windowSince?.toISOString() ?? null,
        windowApplied: Boolean(windowSince),
        trackedNotEnforced: true,
      };
    });
  }

  async triggerRetrain(payload: RetrainTriggerDto): Promise<RetrainTriggerResponseDto> {
    const response: RetrainTriggerResponseDto = {
      jobId: randomUUID(),
      documentType: payload.documentType,
      minCorrections: payload.minCorrections ?? 1000,
      dryRun: payload.dryRun ?? false,
      status: 'pending',
      startedAt: new Date().toISOString(),
    };

    await this.audit.log({
      action: 'learning.retrain.trigger',
      actorId: 'system',
      outcome: 'success',
      metadata: {
        documentType: payload.documentType,
        minCorrections: response.minCorrections,
        dryRun: response.dryRun,
        jobId: response.jobId,
      },
    });

    this.logger.info('learning.retrain_triggered', {
      jobId: response.jobId,
      documentType: response.documentType,
      minCorrections: response.minCorrections,
      dryRun: response.dryRun,
      status: response.status,
      startedAt: response.startedAt,
    });

    return response;
  }
}

