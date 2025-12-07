import { Module } from '@nestjs/common';
import { SecurityModule } from './security/security.module';
import { AuthModule } from './auth/auth.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [SecurityModule, AuthModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
