import type { Category } from '@prisma/client';

export type ClassificationSuggestion = {
  categoryId: string;
  confidence: number;
  reason?: string;
};

export type ClassificationResult = {
  suggestions: ClassificationSuggestion[];
};

/**
 * Suggests сферы for a freshly registered incident.
 *
 * The classifier is advisory only. It never assigns a category, never routes an
 * incident and never closes one — the dispatcher decides. Implementations must
 * therefore fail soft: a thrown error or a timeout has to degrade to an empty
 * suggestion list, not to a broken registration flow.
 */
export interface IncidentClassifier {
  readonly enabled: boolean;
  classify(text: string, categories: Category[]): Promise<ClassificationResult>;
}

export const EMPTY_CLASSIFICATION: ClassificationResult = { suggestions: [] };
