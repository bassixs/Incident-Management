-- Полное удаление ИИ-функционала (персональные данные не покидают контур).
--
-- Столбцы хранили только служебные подсказки классификатора и модерации —
-- ни текста обращения, ни ответа жителю в них нет, поэтому удаление
-- безвозвратно, но ничего содержательного не теряет.
ALTER TABLE "Incident" DROP CONSTRAINT IF EXISTS "Incident_aiSuggestedCategoryId_fkey";

ALTER TABLE "Incident" DROP COLUMN IF EXISTS "aiSuggestedCategoryId";
ALTER TABLE "Incident" DROP COLUMN IF EXISTS "aiSuggestions";
ALTER TABLE "Incident" DROP COLUMN IF EXISTS "aiPossibleAbuse";
ALTER TABLE "Incident" DROP COLUMN IF EXISTS "aiPossibleOfftopic";
ALTER TABLE "Incident" DROP COLUMN IF EXISTS "aiModerationReason";

-- История append-only, но записи об ИИ-действиях больше не имеют смысла
-- и содержат выводы модели о тексте жителя.
DELETE FROM "IncidentHistory"
WHERE "action" IN ('AI_CLASSIFIED', 'AI_MODERATED', 'ANSWER_DRAFT_GENERATED');
