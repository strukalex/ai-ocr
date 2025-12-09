import {
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SourceChannel } from '../enums/source-channel.enum';
import { DocumentStatus } from '../enums/status.enum';

class IngestMetadataDto {
  @IsObject()
  @IsOptional()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: Record<string, any>;

  @IsString()
  @IsOptional()
  rawContentBase64?: string;
}

export class DocumentIngestRequestDto {
  @IsEnum(SourceChannel)
  sourceChannel!: SourceChannel;

  @IsUrl({
    protocols: ['http', 'https', 'file', 's3'],
    require_protocol: true,
    require_tld: false,
  })
  originalUri!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  checksum!: string;

  @IsString()
  @IsOptional()
  @MaxLength(128)
  idempotencyKey?: string;

  @ValidateNested()
  @Type(() => IngestMetadataDto)
  @IsOptional()
  metadata?: IngestMetadataDto;
}

export class DocumentIngestResponseDto {
  @IsString()
  @IsNotEmpty()
  documentId!: string;

  @IsEnum(DocumentStatus)
  status: DocumentStatus = DocumentStatus.Uploaded;
}

