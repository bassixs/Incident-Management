# Тестовые зависимости: проверка 30 сентября 2026

## Версии и цепочки

| Пакет и путь | Было | Стало |
| --- | --- | --- |
| корневой vitest | 2.1.9 | 4.1.11 |
| vitest → @vitest/mocker | 2.1.9 | 4.1.11 |
| vitest / @vitest/mocker → vite | 5.4.21 | 6.4.3, явно задан как devDependency |
| vitest → vite-node → vite | vite-node 2.1.9 | vite-node удалён, Vitest 4 использует Module Runner Vite |
| vite → esbuild | 0.21.5 | 0.25.12 |
| tsx 4.23.12 → esbuild | 0.28.2 | без изменений |

Vitest 2/3 не получили исправление redirect mock; минимальная исправленная
стабильная ветка — 4.1.11. Vite 6.4.3 выбран как минимальная совместимая ветка
с исправлениями, без перехода на Vite 7/8 или Vitest 5. Обе прямые версии закреплены
точно; lock-файл фиксирует транзитивные зависимости. Новый override не добавлен.
Обновились также необходимые пакеты тестовой цепочки: @vitest/*, chai и служебные
зависимости Vite/Vitest. Все production-записи lock-файла программно сопоставлены
с отдельным production-коммитом и не изменились. tsx, TypeScript и @types/node
не обновлялись.

При разрешении нового дерева npm 10.9.8 падал внутри Arborist `loadPeerSet`
с `Cannot read properties of null (reading 'edgesOut')`. Lock-файл сформирован
штатным `npx --yes npm@11 install --save-dev --save-exact vitest@4.1.11 vite@6.4.3
--package-lock-only --ignore-scripts --no-audit --no-fund`. Системный npm не заменён,
`--force` и `--legacy-peer-deps` не использовались. Последующая чистая `npm ci`
и Docker-сборка успешно работают обычным npm 10.9.8.

## Официальные advisories

Проверены описания производителей и актуальный npm audit. Указаны диапазоны
для затронутых веток этого проекта; таблица не перечисляет все параллельные ветки.

| Advisory | Уязвимые версии | Исправленная версия |
| --- | --- | --- |
| [GHSA-82fw-gwwq-j7x9](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9), чтение файлов через redirect mock | vitest / @vitest/mocker >=2.1.0 <4.1.11 | 4.1.11 |
| [GHSA-5xrq-8626-4rwp](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp), чтение/исполнение при доступном UI/API | описание производителя: <3.2.5, >=4.0.0 <4.1.0; npm audit: <3.2.6 | выбранная 4.1.11 вне обоих диапазонов |
| [GHSA-4w7w-66w2-5vf9](https://github.com/vitejs/vite/security/advisories/GHSA-4w7w-66w2-5vf9), обход пути через sourcemap | vite <=6.4.1 | 6.4.2 |
| [GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3), UNC/NTLM в launch-editor на Windows | launch-editor <=2.14.0; включающий его vite <=6.4.2 | launch-editor 2.14.1; vite 6.4.3 |
| [GHSA-fx2h-pf6j-xcff](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff), обход server.fs.deny на Windows | vite <=6.4.2 | 6.4.3 |
| [GHSA-67mh-4wv8-2f99](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99), CORS сервера разработки | esbuild <=0.24.2 | 0.25.0 |

vite-node имел транзитивное предупреждение через Vite, отдельного advisory для
него в полученном отчёте нет. Расхождение диапазона Vitest UI между источниками
отмечено явно; для выбранной версии оно не меняет результат.

## Применимость к проекту

Уязвимые версии в прежнем dev-дереве подтверждены. Достижимость эксплуатации
в нашем проекте не доказана: конфигурация использует Node-тесты, без browser/UI,
публичного API тестов и standalone mockerPlugin. Скрипт разработки приложения —
tsx watch, а не Vite serve. esbuild используется для преобразования, не как
отдельный сервер. Опасные сценарии advisories требуют доступного соответствующего
сервера/плагина; отдельные Vite-сценарии дополнительно зависят от Windows.
Это не разрешение публиковать тестовые серверы наружу. В runtime-образе эти dev-
пакеты отсутствуют; его веб-сервер — Fastify.

## Совместимость тестов

Сверены [руководство Vitest 4](https://v4.vitest.dev/guide/migration) и ограничения
пакетов: Vite >=6, Node 20/22 или >=24. Проверенная среда — Node 22.23.2.
Существующая конфигурация `environment: node`, `pool: threads`,
`fileParallelism: false` и явный include `tests/**/*.test.ts` сохранена.
Новые правила mocks, отсутствие vite-node и изменённые defaults исключений
не потребовали изменения конфигурации или рабочего кода. Проверки не отключались,
таймауты существующих тестов не увеличивались.

В дополнительно включённом overdue-report.test.ts обнаружено прежнее ожидание
ФИО жителя в листе просрочек. Оно воспроизведено и на Vitest 2.1.9 с прежним кодом:
1 failure / 3 passed. Колонка уже удалена из приложения при обезличивании ранее.
Ожидание заменено точными проверками номера, часов просрочки, группы и отсутствия
старых ФИО/отдельного телефона на обоих листах. Синтетические старые данные
оставлены в fixture именно для проверки их неразглашения. Excel-код не менялся.

## Выполненные проверки

Проверки проходят в отдельном каталоге старого сервера. Интеграционные тесты
используют только incident_test; запуск образа — новый PostgreSQL в отдельной
закрытой сети без рабочих томов, токена и внешнего доступа.

- Чистая npm ci, Prisma generate, typecheck, build.
- Все unit-тесты и объединённый расширенный интеграционный набор: optional-contact,
  resident-privacy, working-chat-access, parallel-inbox, requester-preview-photos,
  max-photo-delivery, pinned-panel-recovery, work-queues, distribution-queue,
  reliable-delivery, parallel-outbox, review-and-delivery, delivery-problem,
  lease-timezone, private-workspace, sla-and-idempotency; дополнительно overdue-report.
- Итог повторного полного прогона после исправления ожидания отчёта: **60 файлов,
  656 тестов, 0 ошибок, 0 пропусков**; из них 43 unit-файла / 432 теста и
  17 интеграционных файлов / 224 теста.
- Итоговый образ собран неизменённым Dockerfile; его runtime-слой использует
  отдельную npm ci --omit=dev. Все экземпляры brace-expansion и fast-uri проверены
  автономными регрессиями с `--network none`; dev-пакетов в runtime-дереве нет.
- Реальный dist/index.js запущен с новой БД и заглушкой MAX в закрытой сети.
  /health и /ready — 200; вебхук без секрета — 401; неверное тело — 400;
  синтетическое событие и его повтор — 200, повтор помечен duplicate=true.
  Inbox: 1 PROCESSED; outbox и сообщения жителей: 0. SIGTERM — код 0,
  graceful shutdown completed. Тестовые контейнеры и сеть удалены.
- Образ: `sha256:5bef4df245a87d4c131b2722a7401f81520e2608ee8582c5143fba96e8f909a3`;
  Node 22.23.2, npm 10.9.8.
- npm audit до обоих исправлений: 6 пакетов (3 moderate, 2 high, 1 critical).
  После: 0; npm audit --omit=dev: 0. Production audit внутри runtime-образа: 0.

Чистый audit означает отсутствие известных этому источнику предупреждений для
этого дерева на дату проверки, не отсутствие всех возможных уязвимостей.
Остались сообщения deprecated: inflight 1.0.6, rimraf 2.7.1, lodash.isequal 4.5.0,
glob 7.2.3, fstream 1.0.12 в цепочках ExcelJS. В частности glob предупреждает
о прекращении поддержки и исторических уязвимостях; нулевой audit не отменяет
этого предупреждения. Обновление этих несвязанных цепочек требует отдельной
проверки совместимости и не включено в текущую задачу.

Рабочий контейнер incident-bot-app-1 остаётся running=false, restart=no.
Вебхуки, сервер Минцифры и рабочие данные не менялись. Живой прогон MAX не выполнялся.
Архивы передачи не пересобирались; миграции БД для этих dependency-исправлений не нужны.
Локальный Windows node_modules не заменялся проверенным Linux-деревом: после
получения коммитов для другого окружения нужна npm ci / пересборка образа.
