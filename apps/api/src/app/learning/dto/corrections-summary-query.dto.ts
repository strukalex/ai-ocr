import { IsISO8601, IsOptional, IsString } from 'class-validator';

export class CorrectionsSummaryQueryDto {
  @IsOptional()
  @IsString()
  documentType?: string;

  @IsOptional()
  @IsString()
  fieldPath?: string;

  @IsOptional()
  @IsISO8601()
  since?: string;
}

