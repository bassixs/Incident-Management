export type ModerationResult = {
  possibleAbuse: boolean;
  possibleOfftopic: boolean;
  reason?: string;
};

/**
 * Flags text for a human to look at. Nothing here may ban anyone: the result
 * only decorates the distribution card, and a person decides what to do.
 */
export interface ModerationService {
  readonly enabled: boolean;
  analyze(text: string): Promise<ModerationResult>;
}

export const CLEAN_MODERATION: ModerationResult = {
  possibleAbuse: false,
  possibleOfftopic: false,
};
