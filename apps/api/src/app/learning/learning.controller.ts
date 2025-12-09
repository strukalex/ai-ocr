import { Body, Controller, Get, HttpCode, Post, Query, ValidationPipe } from '@nestjs/common';
import { CorrectionsSummaryQueryDto } from './dto/corrections-summary-query.dto';
import { RetrainTriggerDto } from './dto/retrain-trigger.dto';
import {
  CorrectionAggregateDto,
  LearningService,
  RetrainTriggerResponseDto,
} from './learning.service';

@Controller('learning')
export class LearningController {
  constructor(private readonly learning: LearningService) {}

  @Get('corrections/summary')
  async getCorrectionsSummary(
    @Query(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    query: CorrectionsSummaryQueryDto,
  ): Promise<CorrectionAggregateDto[]> {
    return this.learning.getCorrectionSummary(query);
  }

  @Post('retrain')
  @HttpCode(202)
  async triggerRetrain(
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    body: RetrainTriggerDto,
  ): Promise<RetrainTriggerResponseDto> {
    return this.learning.triggerRetrain(body);
  }
}

