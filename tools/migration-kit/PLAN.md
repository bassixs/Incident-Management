> Редакция exporter-v2: прежде прочитайте EXPORTER-REVIEW.md и KIT.json.
> Используйте весь комплект одной редакции; новый snapshot_exporter.py обязателен.
> Не продолжайте сохранённую неудачную попытку. Для новой capture нужен новый
> абсолютный OUTPUT, старый каталог и журналы остаются для разбора.
> При отказе/EOF/exit экспортёра app не останавливать, миграции не начинать.
> Проверенная копия требует restore-result.json с успешным verify; один dump или
> exporter-result.json недостаточен. Новое применение требует отдельного разрешения.

# Эксплуатационный комплект PR №14–18, редакция pr14-18-v1

Только ревью. Подготовка на сервере и установка требуют отдельного разрешения.
Не смешивать этот каталог со старым комплектом 60a9056. KIT.json содержит точный
SHA скриптов, IMAGES.json — три разрешённые версии и config/image ID.
IMAGE-BINDINGS.json содержит только соответствующие OCI manifest ID, если они
есть в проверенных архивах; Docker/containerd может показывать именно их.
При будущей подготовке выбрать фактический ID из этого списка, не добавлять
произвольный ID по совпадению revision-label. Неизвестное представление — отказ. SHA256SUMS защищает
все материалы. Прежний комплект сохранить отдельно, не использовать для обновления.

## Закреплённые версии и изменения схемы

- old: 59149006a7b3d30d01218fad84360e7d71e6d79e;
- main: c41f2d532591ddeb2ce0ea3d217e8a1a2095f38a;
- reserve: 3c5c38b0f6477d5124593406f09f3af4c2db0c12.

Применяются только 20261007120000_working_hour_policy и
20261007160000_working_deadline_disposition: IncidentAssignmentCycle, поля политики
и рабочих сроков, DEFERRED/CANCELLED, cancelledAt/cancelReason. Runtime и SQL не
редактировались. deliveryProgress v1 хранится внутри OutboundMessage.payload,
не в отдельном столбце; снимок охватывает весь payload. Использованы уже проверенные образы из Actions 37686043412,
артефакт 11510892680. В комплект включён тот же main-and-reserve.tar.gz побайтно.

schema-expectations.json получен применением закреплённых миграций в чистой
PostgreSQL 16. Проверяются identity, вся история и завершённость миграций, столбцы,
enum со всеми значениями, ограничения, индексы, семь триггеров и guard-функция.
Только две прежние пары LF/CRLF из migration_guard.py разрешены по точным именам
миграций. Не принимать фактическую production-схему за новый эталон.

## Зависимости и будущая приватная подготовка

Linux/amd64, Python >=3.11 (stdlib/fcntl), Docker Engine с Compose v2, PostgreSQL16,
доступная роль для pg_control_system и pg_export_snapshot/pg_dump, текущая схема
old. JSON Compose допустим. Архив содержит scripts, эталон, исходники main/reserve,
образы и протоколы; старые каталоги скриптам не нужны. Старый образ НЕ включён:
сохранить действующий образ из разрешённой пары config/manifest ID на сервере. Никаких сборок.

На сервере отдельно сверить единственный экземпляр, restart=no (не менять молча),
порт только127.0.0.1, ротацию20m×5, mounts/права, фактические Docker/PG, свободное
место, отсутствие сборок/очисток и расписание резервирования. Предварительно
загрузить образы только после разрешения. Прежние материалы/копии сохраняются.
PG-образ для проверки восстановления должен быть заранее доступен и закреплён
config ID в backup.restore_image. Он запускается с network=none, 0.5CPU/768MiB;
приложение из копии не запускается. БД источника не восстанавливается поверх себя.

Создать новый закрытый PREPARED (0700), settings.json (0600), run-каталоги,
compose-before.yml и два кандидата. Все пути абсолютные. Действующий runtime.env
не копировать в публичный комплект и не менять. Settings:

- kit="pr14-18-v1"; policy="LEGACY" либо явное решение "WORKING_HOURS_V1";
- install, prepared, backup_script, backup_lock, releases, app, project, health_base;
- runtime_sha256 и baseline_config_sha256;
- images.old/main/reserve: id, revision из IMAGES.json, candidate, compose_sha256;
- migration: network, уникальный container, manifest, manifest_sha256,
  identity={system,database,oid} из безопасного GET/read-only probe;
- backup: postgres, postgres_id (полный контейнерID), user, database, uploads,
  restore_image (полный sha256 ID локального PostgreSQL16).

Кандидаты отличаются только образом и, при отдельном решении активировать сроки,
единственным environment.INCIDENT_SLA_POLICY=WORKING_HOURS_V1. Базовая политика
должна быть LEGACY. Другие отличия запрещены; оба кандидата имеют ОДИНАКОВУЮ
политику. Это override Compose, runtime.env неизменен. Изменение settings после
начала операции нарушает settingsHash — отказ. Если решено пока сохранить LEGACY,
позднейшая активация требует отдельного подготовленного и проверенного плана.

backup-data.py — новый полный инструмент копии и проверки. Он не устанавливает
таймер. Действующий плановый механизм перед установкой отдельно проверить: полный
pg_dump, вложения и конфигурация, отсутствие старых whitelist таблиц/статусов.
update-backup-metadata.py меняет только три проверенные строки REV/IMAGE/source;
не считать это автоматическим исправлением произвольного старого backup-script.
Если реальный механизм содержит несовместимые выборки — остановиться на его ревью.

## Точные команды (пути задаются при отдельной приватной подготовке)

Сначала сверить внешний .sha256 и внутренний SHA256SUMS, затем:

```bash
sha256sum -c installation-kit-pr14-18.zip.sha256
# распаковка в новый пустой закрытый каталог; не поверх прежнего
cd "$KIT"
sha256sum -c SHA256SUMS
# только будущая разрешённая подготовка:
docker load -i "$KIT/main-and-reserve.tar.gz"
export KIT SETTINGS RUN=install-main
# SETTINGS — абсолютный путь к новым приватным настройкам; KIT — к этой редакции
python3 "$KIT/scripts/locked-session.py" --settings "$SETTINGS" -- bash
# команды ниже выполняются в этой дочерней shell с унаследованным flock
set -euo pipefail
get() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); [None for _ in []];
for k in sys.argv[2].split("."): v=v[k]
print(v)' "$SETTINGS" "$1"; }
OLD=$(get images.old.id); MAIN=$(get images.main.id); RESERVE=$(get images.reserve.id)
PREPARED=$(get prepared)
mkdir "$PREPARED/$RUN"
python3 "$KIT/scripts/backup-data.py" --settings "$SETTINGS" capture --schema old --output "$PREPARED/fresh"
python3 "$KIT/scripts/backup-data.py" --settings "$SETTINGS" verify --output "$PREPARED/fresh"
# до BACKUP_RESTORE_VERIFIED приложение не останавливать
python3 "$KIT/scripts/stop-app.py" --settings "$SETTINGS" "$OLD" "$RUN"
python3 "$KIT/scripts/backup-data.py" --settings "$SETTINGS" capture --schema old --final-run "$RUN" --output "$PREPARED/final"
python3 "$KIT/scripts/backup-data.py" --settings "$SETTINGS" verify --output "$PREPARED/final"
python3 "$KIT/scripts/migrate-app.py" --settings "$SETTINGS" "$RUN"
# ТОЛЬКО при явном разрешении активации и policy=WORKING_HOURS_V1:
python3 "$KIT/scripts/activate-policy.py" --settings "$SETTINGS" activate-WORKING_HOURS_V1-for-new-incidents
# при policy=LEGACY эту команду не выполнять
python3 "$KIT/scripts/apply-config.py" --settings "$SETTINGS" "$OLD" "$MAIN" "$(get baseline_config_sha256)" "$(get images.main.candidate)" "$RUN"
python3 "$KIT/scripts/start-app.py" --settings "$SETTINGS" "$MAIN" "$RUN"
```

Не запускать блок вслепую: после каждой границы проверять результат. SIGTERM до75с,
без SIGKILL; штатный exit0, отсутствиеOOM и graceful shutdown log обязательны.
Readiness до120с, schema probe до30с. Один тайм-аут не доказывает дефект — сохранить
журнал и диагностировать. Повторный start в той же операции запрещён.

Явный activation receipt записывается после успешных миграций при остановленном
app. Активация реально действует только после запуска: старые обращения сохраняют
LEGACY и прежние даты; только регистрации после запуска получают новую политику.
Никакого массового UPDATE. Резерв сохраняет эту же настройку.

После готовности сделать контрольную копию/сверку:

```bash
python3 "$KIT/scripts/backup-data.py" --settings "$SETTINGS" capture --schema new --output "$PREPARED/after"
python3 "$KIT/scripts/backup-data.py" --settings "$SETTINGS" verify --output "$PREPARED/after"
python3 "$KIT/scripts/reconcile-data.py" --before "$PREPARED/final/data.json" --after "$PREPARED/after/data.json" --migrated --report "$PREPARED/reconciliation.json"
```

Сверка включает ВСЕ поля/таблицы; допускает только известные новые nullable/default
поля миграций. Новые записи, изменение статусов, циклов, progress и дедлайнов после
старта выдаются как DATA_REVIEW_REQUIRED: сверить по истории и доставленнымACK,
не принимать автоматически. Потеря записи/фотографии — остановка для разбора.
Отдельно сверить панели/закрепления, исторические наборы >4фото, исходные FAILED,
CANCELLED, DEFERRED, отмены, inbox и движение обычной очереди. Реальные обращения
ради проверки не обрабатывать. Публичных текстов/данных в отчёт не включать.

После подтверждённого технического успеха:

```bash
python3 "$KIT/scripts/update-backup-metadata.py" --settings "$SETTINGS" "$(get images.old.revision)" "$OLD" "$(get images.main.revision)" "$MAIN"
exit # освобождает backup.lock; не ждать ручного теста владельца
# FINAL_OUTPUT — заранее подготовленный абсолютный путь новой итоговой копии
export FINAL_OUTPUT
python3 "$KIT/scripts/locked-session.py" --settings "$SETTINGS" -- bash -c 'set -e; python3 "$KIT/scripts/backup-data.py" --settings "$SETTINGS" capture --schema new --output "$FINAL_OUTPUT"; python3 "$KIT/scripts/backup-data.py" --settings "$SETTINGS" verify --output "$FINAL_OUTPUT"'
```

Для итоговой копии предпочтительнее приватный короткий bash-файл с двумя простыми
capture/verify командами и конкретным абсолютным OUTPUT, подготовленный заранее.
Не держать flock в ожидании ручной проверки. Освобождение не удаляет backup.lock:
файл остаётся, освобождается именно flock. Ошибки дают ненулевой exit и освобождают
блокировку при выходе shell. Не оставлять detached-процессы с FD.

## Отмена, резерв, неизвестный результат

До migrate-app и только при неизменённой схеме/контейнере/Compose/журналах:
`resume-unapplied.py --settings SETTINGS OLD RUN` возобновляет ТОТ ЖЕ контейнер.
Один только отсутствующий applied.json недостаточен; после migration-intent старый
59149006 запрещён навсегда для этой попытки. Частичная/неизвестная миграция — стоп
дальнейшего переключения, сохранить ledger/Prisma-контейнер, освободить lock,
разбор. Не применять migrate resolve, не удалять intent, не восстанавливать дамп.

Подтверждённая новая схема и отказ создания/старта основной версии:

```bash
python3 "$KIT/scripts/recover-config.py" --settings "$SETTINGS" "$MAIN" "$RESERVE" "$(get images.main.compose_sha256)" "$RUN" reviewed-start-failure
python3 "$KIT/scripts/start-app.py" --settings "$SETTINGS" "$RESERVE" "$RUN"
```

Сохраняются проверка точной попытки, stopped/created-контейнера, exit/OOM и окно300с.
Работающий, зависший, изменившийся или неопределённый кандидат не допускает recover.
Уже готовая main с подтверждённой проблемой: новый RUN2, stop main, apply
main→reserve (SHA текущего main Compose), start reserve. Аналогично reserve→main.
Новый RUN нельзя использовать для обхода отказавшей/неясной попытки.
Метаданные копии обновлять на фактический reserve, если выбран он.

Резерв помогает при специфическом дефекте основного цикла доставки; общие runtime,
схема, миграции, файловые защиты и бизнес-логика у него общие. Ошибку миграции он не
лечит. ПотерянныйACK остаётся неизвестностью. Нельзя сбрасывать deliveryProgress,
оживлять FAILED/CANCELLED, очищать очередь или выставлять фиктивныйSENT.
