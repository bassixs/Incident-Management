import type { Category, Incident } from '@prisma/client';

/**
 * Produces a *draft* reply for a responder to edit.
 *
 * The generator never sends anything: its output always travels the normal
 * RESPONDER → REVIEW → APPROVER path before reaching the requester.
 */
export interface AnswerDraftGenerator {
  readonly enabled: boolean;
  generate(incident: Incident, category: Category, template?: string | null): Promise<string>;
}
