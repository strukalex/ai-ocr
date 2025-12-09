import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@my-org/database';
import {
  IntakeSourceCreateRequestDto,
  IntakeSourceDto,
  IntakeSourceUpdateRequestDto,
} from '@my-org/shared-types';

@Injectable()
export class IntakeSourcesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<IntakeSourceDto[]> {
    const sources = await this.prisma.intakeSource.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return sources.map(this.toDto);
  }

  async create(payload: IntakeSourceCreateRequestDto): Promise<IntakeSourceDto> {
    const created = await this.prisma.intakeSource.create({
      data: {
        type: payload.type,
        uri: payload.uri,
        credentialsRef: payload.credentialsRef ?? null,
        pollingIntervalSeconds: payload.pollingIntervalSeconds ?? null,
        active: true,
      },
    });
    return this.toDto(created);
  }

  async update(
    sourceId: string,
    payload: IntakeSourceUpdateRequestDto,
  ): Promise<IntakeSourceDto> {
    try {
      const updated = await this.prisma.intakeSource.update({
        where: { id: sourceId },
        data: this.buildUpdateData(payload),
      });
      return this.toDto(updated);
    } catch (err) {
      if (this.isNotFoundError(err)) {
        throw new NotFoundException(`Intake source ${sourceId} not found`);
      }
      throw err;
    }
  }

  async disable(sourceId: string): Promise<void> {
    try {
      await this.prisma.intakeSource.update({
        where: { id: sourceId },
        data: { active: false },
      });
    } catch (err) {
      if (this.isNotFoundError(err)) {
        throw new NotFoundException(`Intake source ${sourceId} not found`);
      }
      throw err;
    }
  }

  private toDto = (source: {
    id: string;
    type: string;
    uri: string;
    credentialsRef: string | null;
    pollingIntervalSeconds: number | null;
    active: boolean;
  }): IntakeSourceDto => ({
    id: source.id,
    type: source.type as IntakeSourceDto['type'],
    uri: source.uri,
    credentialsRef: source.credentialsRef,
    pollingIntervalSeconds: source.pollingIntervalSeconds,
    active: source.active,
  });

  // Prisma throws a generic error; narrow for missing records without coupling to client version detail.
  private isNotFoundError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      !!error &&
      'code' in error &&
      (error as { code?: string }).code === 'P2025'
    );
  }

  // Only include properties provided by the caller; Prisma treats undefined as an invalid value.
  private buildUpdateData(
    payload: IntakeSourceUpdateRequestDto,
  ): Prisma.IntakeSourceUpdateInput {
    const data: Prisma.IntakeSourceUpdateInput = {};

    if (payload.type !== undefined) data.type = payload.type;
    if (payload.uri !== undefined) data.uri = payload.uri;
    if (payload.credentialsRef !== undefined) data.credentialsRef = payload.credentialsRef;
    if (payload.pollingIntervalSeconds !== undefined)
      data.pollingIntervalSeconds = payload.pollingIntervalSeconds;
    if (payload.active !== undefined) data.active = payload.active;

    return data;
  }
}
