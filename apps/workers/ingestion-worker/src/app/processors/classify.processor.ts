import { Injectable } from '@nestjs/common';
import { PrismaService } from '@my-org/database';
import { AuditLogger, LoggerService } from '@my-org/observability';
import { DocumentStatus, SourceChannel } from '@my-org/shared-types';
import axios from 'axios';
import { Job } from 'bullmq';

export interface ClassifyJobPayload {
  documentId: string;
  filename?: string;
  metadata?: Record<string, unknown>;
  sourceChannel?: SourceChannel | string;
  /**
   * Optional normalized text content (e.g., OCR output) for content-based classification.
   */
  text?: string;
  traceId?: string;
}

interface ClassificationCandidate {
  type: string;
  confidence: number;
}

interface ClassificationResult extends ClassificationCandidate {
  provider: string;
  ambiguousCandidates: ClassificationCandidate[];
}

interface StrategyInput {
  payload: ClassifyJobPayload;
  tier: string;
}

const DEFAULT_THRESHOLD = 0.85;

@Injectable()
export class ClassifyProcessor {
  private readonly threshold: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogger,
    private readonly logger: LoggerService,
  ) {
    this.threshold = Number(process.env['CLASSIFICATION_THRESHOLD'] ?? DEFAULT_THRESHOLD);
  }

  async handle(job: Job<ClassifyJobPayload>): Promise<void> {
    const payload = job.data;
    const traceId = payload.traceId ?? job.id?.toString();

    const document = await this.prisma.document.findUnique({
      where: { id: payload.documentId },
      select: {
        id: true,
        status: true,
        classificationConf: true,
        classificationType: true,
        processingProfileId: true,
      },
    });

    if (!document) {
      this.logger.warn('classification.document_missing', {
        documentId: payload.documentId,
        traceId,
      });
      return;
    }

    const tier = await this.resolveTier(document.processingProfileId);
    const { result, ordered } = await this.runStrategies({ payload, tier });
    const ambiguous = this.isAmbiguous(result, ordered);
    const isUnknown = result.type === 'unknown';

    const secondBestType = ordered[1]?.type;
    await this.prisma.document.update({
      where: { id: payload.documentId },
      data: {
        status: isUnknown
          ? DocumentStatus.Exception
          : ambiguous
          ? DocumentStatus.PendingReview
          : DocumentStatus.Classified,
        stateReason: isUnknown
          ? 'Unknown document type; requires configuration'
          : ambiguous
          ? `Classification requires confirmation (${result.type}${
              secondBestType ? ` vs ${secondBestType}` : ''
            } score ${result.confidence.toFixed(2)} < ${this.threshold.toFixed(2)} or ambiguous)`
          : null,
        classificationType: result.type,
        classificationConf: result.confidence,
      },
    });

    await this.audit.log({
      action: 'ingestion.classified',
      actorId: 'system',
      outcome: 'success',
      documentId: payload.documentId,
      traceId,
      metadata: {
        provider: result.provider,
        confidence: result.confidence,
        tier,
        ambiguous: ambiguous ? result.ambiguousCandidates : [],
        signals: ordered.slice(0, 3),
      },
    });

    const logMethod = isUnknown ? this.logger.warn.bind(this.logger) : this.logger.info.bind(this.logger);
    logMethod('ingestion.classified', {
      documentId: payload.documentId,
      traceId,
      confidence: result.confidence,
      provider: result.provider,
      type: result.type,
      ambiguous,
    });
  }

  private async resolveTier(processingProfileId?: string | null): Promise<string> {
    if (!processingProfileId) {
      return process.env['CLASSIFIER_TIER'] ?? 'layoutlm';
    }

    const profile = await this.prisma.processingProfile.findUnique({
      where: { id: processingProfileId },
      select: { classificationTier: true },
    });

    return profile?.classificationTier ?? process.env['CLASSIFIER_TIER'] ?? 'layoutlm';
  }

  private async runStrategies(
    input: StrategyInput,
  ): Promise<{ result: ClassificationResult; ordered: ClassificationCandidate[] }> {
    const heuristic = this.classifyHeuristically(input.payload);
    const candidates: ClassificationResult[] = [heuristic];

    if (input.tier === 'layoutlm' || input.tier === 'structured') {
      const layoutResult = await this.classifyWithLayoutLm(input.payload, heuristic);
      if (layoutResult) candidates.push(layoutResult);
    }

    if (input.tier === 'llm' || input.tier === 'unstructured') {
      const llmResult = await this.classifyWithLlm(input.payload, heuristic);
      if (llmResult) candidates.push(llmResult);
    }

    const best = candidates.reduce((prev, current) =>
      current.confidence > prev.confidence ? current : prev,
    );

    const ordered = [...candidates]
      .map((c) => ({ type: c.type, confidence: c.confidence }))
      .sort((a, b) => b.confidence - a.confidence);

    return {
      result: {
        ...best,
        ambiguousCandidates: ordered.slice(0, 3),
      },
      ordered,
    };
  }

  private async classifyWithLayoutLm(
    payload: ClassifyJobPayload,
    fallback: ClassificationResult,
  ): Promise<ClassificationResult | null> {
    const endpoint = process.env['LAYOUTLM_CLASSIFIER_URL'];
    if (!endpoint) return null;

    try {
      const response = await axios.post(endpoint, {
        filename: payload.filename,
        metadata: payload.metadata,
        sourceChannel: payload.sourceChannel,
        traceId: payload.traceId,
        text: payload.text,
      });

      const data = response.data ?? {};
      if (data.type && typeof data.confidence === 'number') {
        return {
          type: data.type,
          confidence: data.confidence,
          provider: 'layoutlm',
          ambiguousCandidates: this.normalizeCandidates(data.candidates),
        };
      }
    } catch (err) {
      this.logger.warn('classification.layoutlm_failed', {
        traceId: payload.traceId,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }

    return {
      ...fallback,
      provider: 'layoutlm-fallback',
    };
  }

  private async classifyWithLlm(
    payload: ClassifyJobPayload,
    fallback: ClassificationResult,
  ): Promise<ClassificationResult | null> {
    const endpoint = process.env['LLM_CLASSIFIER_URL'];
    if (!endpoint) return null;

    try {
      const response = await axios.post(endpoint, {
        filename: payload.filename,
        metadata: payload.metadata,
        sourceChannel: payload.sourceChannel,
        traceId: payload.traceId,
        text: payload.text,
        prompt: 'classify document type',
      });
      const data = response.data ?? {};
      if (data.type && typeof data.confidence === 'number') {
        return {
          type: data.type,
          confidence: data.confidence,
          provider: 'llm',
          ambiguousCandidates: this.normalizeCandidates(data.candidates),
        };
      }
    } catch (err) {
      this.logger.warn('classification.llm_failed', {
        traceId: payload.traceId,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }

    return {
      ...fallback,
      provider: 'llm-fallback',
    };
  }

  private classifyHeuristically(payload: ClassifyJobPayload): ClassificationResult {
    const textPart = (payload.text ?? '').toLowerCase();
    const metaPart = `${payload.filename ?? ''} ${JSON.stringify(payload.metadata ?? {})}`.toLowerCase();

    const candidates: ClassificationCandidate[] = [];

    // Helper to push a candidate with different weights depending on signal source.
    const pushHit = (type: string, fromText: boolean, fromMeta: boolean, base: number) => {
      // If we match on filename/metadata alone, treat it as definitive (confidence 1).
      const confidence = fromText ? base : fromMeta ? 1 : base - 0.2;
      candidates.push({ type, confidence: Math.max(confidence, 0.1) });
    };

    const test = (pattern: RegExp) => ({
      text: pattern.test(textPart),
      meta: pattern.test(metaPart),
    });

    const invoice = test(/\binvoice\b|inv[-_\s]?/i);
    if (invoice.text || invoice.meta) pushHit('invoice', invoice.text, invoice.meta, 0.92);

    const receipt = test(/receipt|pos|till/i);
    if (receipt.text || receipt.meta) pushHit('receipt', receipt.text, receipt.meta, 0.78);

    const bol = test(/bill of lading|bol/i);
    if (bol.text || bol.meta) pushHit('bill_of_lading', bol.text, bol.meta, 0.8);

    const contract = test(/contract|agreement/i);
    if (contract.text || contract.meta) pushHit('contract', contract.text, contract.meta, 0.86);

    const identity = test(/id card|passport|driver/i);
    if (identity.text || identity.meta) pushHit('identity', identity.text, identity.meta, 0.7);

    if (candidates.length === 0) {
      candidates.push({ type: 'unknown', confidence: 0.4 });
    }

    candidates.sort((a, b) => b.confidence - a.confidence);
    const best = candidates[0];

    return {
      type: best.type,
      confidence: best.confidence,
      provider: 'heuristic',
      ambiguousCandidates: candidates.slice(0, 3),
    };
  }

  private normalizeCandidates(raw: any): ClassificationCandidate[] {
    if (!Array.isArray(raw)) return [];
    return (raw as any[])
      .map((item) => ({
        type: item?.type ?? item?.label ?? 'unknown',
        confidence: typeof item?.confidence === 'number' ? item.confidence : 0,
      }))
      .filter((c) => !!c.type)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);
  }

  private isAmbiguous(result: ClassificationResult, ordered: ClassificationCandidate[]): boolean {
    const belowThreshold = result.confidence < this.threshold;
    const topTwo = ordered.slice(0, 2);
    const secondBest = topTwo[1];
    const closeScores =
      secondBest !== undefined && result.confidence - secondBest.confidence < 0.1;
    return belowThreshold || closeScores;
  }
}


