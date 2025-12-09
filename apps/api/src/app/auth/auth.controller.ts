import { Body, Controller, HttpCode, Post, ValidationPipe } from '@nestjs/common';
import { AuthLoginRequestDto, AuthTokens } from '@my-org/shared-types';
import { Public } from './public.decorator';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: AuthLoginRequestDto,
  ): Promise<AuthTokens> {
    return this.authService.loginWithPassword(body);
  }
}

