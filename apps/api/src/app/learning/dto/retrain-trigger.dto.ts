import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class RetrainTriggerDto {
  @IsString()
  documentType!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  minCorrections?: number;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

