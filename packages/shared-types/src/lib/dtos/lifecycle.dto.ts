import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { DocumentStatus } from '../enums/status.enum';

export class ClassificationCandidateDto {
  @IsString()
  type!: string;

  @IsNumber()
  confidence!: number;
}

export class ClassificationDto {
  @IsString()
  type!: string;

  @IsNumber()
  confidence!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ClassificationCandidateDto)
  @IsOptional()
  ambiguousCandidates?: ClassificationCandidateDto[];
}

export class ValidationIssueDto {
  @IsString()
  issueCode!: string;

  @IsString()
  message!: string;

  @IsString()
  @IsOptional()
  fieldPath?: string;

  @IsString()
  @IsOptional()
  severity?: 'info' | 'warning' | 'error';
}

export class DocumentStatusDto {
  @IsString()
  documentId!: string;

  @IsString()
  @IsOptional()
  parentDocumentId?: string | null;

  @IsArray()
  @IsOptional()
  childDocumentIds?: string[];

  @IsEnum(DocumentStatus)
  status!: DocumentStatus;

  @IsString()
  @IsOptional()
  stateReason?: string;

  @ValidateNested()
  @Type(() => ClassificationDto)
  @IsOptional()
  classification?: ClassificationDto;

  @IsString()
  @IsOptional()
  templateVersionId?: string | null;

  @ValidateNested({ each: true })
  @IsArray()
  @Type(() => ValidationIssueDto)
  @IsOptional()
  validationIssues?: ValidationIssueDto[];
}

