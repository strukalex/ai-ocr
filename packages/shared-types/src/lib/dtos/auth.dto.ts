import { IsNotEmpty, IsString } from 'class-validator';

export class AuthLoginRequestDto {
  @IsString()
  @IsNotEmpty()
  username!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class AuthCodeRequestDto {
  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsString()
  codeVerifier?: string;

  @IsString()
  redirectUri?: string;
}

export class AuthBearerExchangeDto {
  @IsString()
  @IsNotEmpty()
  accessToken!: string;
}

