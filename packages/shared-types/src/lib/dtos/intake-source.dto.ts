import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
} from 'class-validator';
import { SourceChannel } from '../enums/source-channel.enum';

export class IntakeSourceCreateRequestDto {
  @IsEnum(SourceChannel)
  type!: SourceChannel;

  @IsUrl({
    protocols: ['http', 'https', 's3', 'smb', 'file'],
    require_tld: false,
  })
  uri!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  credentialsRef?: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  pollingIntervalSeconds?: number;
}

export class IntakeSourceUpdateRequestDto {
  @IsOptional()
  @IsEnum(SourceChannel)
  type?: SourceChannel;

  @IsOptional()
  @IsUrl({
    protocols: ['http', 'https', 's3', 'smb', 'file'],
    require_tld: false,
  })
  uri?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  credentialsRef?: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  pollingIntervalSeconds?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class IntakeSourceDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsEnum(SourceChannel)
  type!: SourceChannel;

  @IsUrl()
  uri!: string;

  @IsOptional()
  @IsString()
  credentialsRef?: string | null;

  @IsOptional()
  @IsInt()
  pollingIntervalSeconds?: number | null;

  @IsBoolean()
  active!: boolean;
}
