-- Официальное название ведомства, которое подписывает ответ жителю.
-- Отдельно от Category.name: name — тема для маршрутизации, здесь — организация.
ALTER TABLE "Category" ADD COLUMN IF NOT EXISTS "authorityName" TEXT;
