import { Module } from '@nestjs/common';
import { DatabaseModule } from '@my-org/database';
import { IntakeSourcesController } from './intake-sources.controller';
import { IntakeSourcesService } from './intake-sources.service';

@Module({
  imports: [DatabaseModule],
  controllers: [IntakeSourcesController],
  providers: [IntakeSourcesService],
  exports: [IntakeSourcesService],
})
export class IntakeSourcesModule {}
