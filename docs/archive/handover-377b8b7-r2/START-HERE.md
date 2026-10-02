> **Архив пакета 377b8b7-r2, не инструкция для текущего main.**
> Эти команды и описания поведения относятся только к приложению
> `377b8b7837037e8aaad4e98530d02588f086edb2`. Совместимость с `76da343`
> и более новыми версиями не проверена. Логика инструментов сохранена.
> Это публичная копия документа, а не полный пакет установки; см. [README.md](README.md).
> Пути `$HOME/incident-transfer` — пример исторической структуры, не адрес реальной установки.

# Обновление действующей установки Минцифры — пакет r2

Исправлены только инструменты и инструкция пакета. Если приложение 377b8b7
уже установлено, используйте PATCH-TOOLS.md: повторная установка не нужна.

Приложение: **377b8b7837037e8aaad4e98530d02588f086edb2**, merge PR №1.
Исходники в project/ получены из этого коммита, а config/ содержит отдельные
инструменты этой редакции пакета. Это обновление, не чистая установка.
В архиве нет базы, вложений и рабочего .env. Материалы r2 внутри исходников
исторические: для этого обновления используйте только ЭТУ инструкцию.

Никаких `down -v`, удаления томов, seed, восстановления чужого дампа и сброса
ID панелей. config/, data/ и verification/ действующей установки не заменяются.
Сначала пройти обновление без очистки. Очистка — отдельно в CLEANUP.md.

## 0. Согласовать окно и проверить условия

Работать в Bash на сервере Минцифры. Во всех шагах сохранять одну оболочку.
Нужны Docker Engine с Compose v2, Bash, Python 3, unzip, tar, rsync, sha256sum,
curl, GNU coreutils (timeout) и место для копии установки, БД, вложений и старого образа. Рекомендуемый
запас: не менее двойного объёма текущих данных плюс 5 ГБ на сборку; проверить df.
Приложение собирается на node:22-alpine, PostgreSQL — существующий postgres:16-alpine.
Точные npm-версии зафиксированы package-lock.json (npm ci).
Сборке нужны Docker Hub (docker/dockerfile:1, node:22-alpine), Alpine apk,
registry.npmjs.org и binaries.prisma.sh. Работе нужны DNS, доверенная цепочка TLS,
HTTPS platform-api2.max.ru и доступ MAX к вашему публичному вебхуку. GitHub и Git
для установки из этого архива не нужны. Не отключать TLS-проверки.

Временную паузу согласовать с участниками. При остановленном app обратный прокси
отвечает ошибкой на вебхук; MAX повторяет доставку ограниченное время, поэтому
не затягивать окно. Вебхук не удалять и не регистрировать заново. Внешние cron,
вторые экземпляры и контейнеры, обрабатывающие ту же БД, должны быть остановлены.
Понедельник после 08:00 МСК — окно догоняющего недельного отчёта: включение
согласованного получателя и запуск приложения в это время может отправить отчёт.
Живые проверки выполнять отдельно после согласования; наш пакет их не запускает.

## 1. Проверить пакет и текущую установку

Поместить ZIP и его .sha256 в домашнюю папку. Имя архива ниже фиксированное:

```bash
set -euo pipefail
umask 077
cd "$HOME"
sha256sum -c Na-svyazi-region40-update-377b8b7-r2.zip.sha256
STAGE=$(mktemp -d "$HOME/incident-update-377b8b7.XXXXXX")
unzip -q Na-svyazi-region40-update-377b8b7-r2.zip -d "$STAGE"
PKG="$STAGE/Na-svyazi-region40"
(cd "$PKG" && sha256sum -c SHA256SUMS > "$STAGE/checksums.log")
ROOT="$HOME/incident-transfer"
cd "$ROOT/project"
dc () { docker compose -p incident-bot -f docker-compose.yml "$@"; }
dc ps -a
APP=$(dc ps -a -q app)
PG=$(dc ps -a -q postgres)
test -n "$APP" && test -n "$PG"
OLD_IMAGE=$(docker inspect "$APP" --format '{{.Image}}')
docker image inspect "$OLD_IMAGE" --format 'image={{.Id}} revision={{index .Config.Labels "org.opencontainers.image.revision"}}'
if test -d .git; then git rev-parse HEAD; fi
if test -f ../verification/source-revision.txt; then cat ../verification/source-revision.txt; fi
docker inspect "$APP" "$PG" --format '{{.Name}} {{range .Mounts}}{{.Type}}:{{.Name}}:{{.Source}} -> {{.Destination}}; {{end}}'
df -h "$ROOT" /var/lib/docker
```

Ожидается: контрольные суммы OK, app и postgres найдены, PostgreSQL healthy.
Записать версию из image label/предыдущего manifest; версия package.json 1.0.0
не идентифицирует коммит. Отсутствие label не доказывает конкретную версию.
По mount-выводу определить действительные том БД и хранилище /app/data/uploads.
Полный docker inspect и docker compose config в чат не выводить: там секреты.

```bash
diff -q docker-compose.yml "$PKG/project/docker-compose.yml"
diff -q Dockerfile "$PKG/project/Dockerfile"
diff -qr prisma "$PKG/project/prisma"
diff -q deploy/Caddyfile "$PKG/project/deploy/Caddyfile"
dc exec -T app node -e 'const c=require("./dist/config").getConfig(); for(const k of ["NODE_ENV","BOT_MODE","WEBHOOK_AUTO_REGISTER","MEDIA_STORAGE","MEDIA_LOCAL_PATH"]) console.log(k+"="+c[k])'
dc run --rm --no-deps -T -e LOG_LEVEL=silent -v "$PKG/config:/ops:ro" --entrypoint node app /ops/snapshot.cjs > "$STAGE/before-live.json"
```

Ожидается отсутствие diff; production/webhook, WEBHOOK_AUTO_REGISTER=false,
MEDIA_STORAGE=local и MEDIA_LOCAL_PATH=data/uploads (либо /app/data/uploads).
Скрипт только читает БД и MAX, не отправляет сообщений. В before-live.json:
webhook.expectedPresent=true, все panels.ok=true, missingPanelChats=[].
Количество панелей определяется их действующей базой; если ожидается 54,
проверить именно 54. Старые потерянные копии этим не считаются исправленными.

При отличиях Compose/Dockerfile/prisma/Caddyfile, другом хранилище/S3, неверном
вебхуке или панели — остановиться до замены файлов и сверить отличия с разработчиком.
Для S3 нужна отдельная согласованная копия bucket; команда tar ниже его не копирует.
Не подменять их конфигурацию типовой. При ошибке API не менять токен и подписку
вслепую; проверить сеть и диалог с правильным ботом.

## 2. Остановить обработку и сделать согласованную копию

Сначала убедиться, что никаких иных процессов бота с этой БД нет.

```bash
BACKUP="$HOME/incident-backup-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$BACKUP"
printf '%s\n' "$OLD_IMAGE" > "$BACKUP/old-image-id.txt"
ROLLBACK_TAG="incident-bot-rollback:$(date -u +%Y%m%dT%H%M%SZ)"
printf '%s\n' "$ROLLBACK_TAG" > "$BACKUP/rollback-tag.txt"
docker tag "$OLD_IMAGE" "$ROLLBACK_TAG"
docker image save "$ROLLBACK_TAG" | gzip > "$BACKUP/app-image.tar.gz"
dc stop -t 75 app
test "$(docker inspect "$APP" --format '{{.State.Running}}')" = false
docker inspect "$APP" --format 'exit={{.State.ExitCode}} finished={{.State.FinishedAt}}'
tar -czf "$BACKUP/installation.tar.gz" -C "$HOME" incident-transfer
cp -p .env "$BACKUP/runtime.env"
dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$BACKUP/database.dump"
dc run --rm --no-deps -T --user root --entrypoint tar app -czf - -C /app/data/uploads . > "$BACKUP/uploads.tar.gz"
dc exec -T postgres pg_restore --list < "$BACKUP/database.dump" > "$BACKUP/database.list"
tar -tzf "$BACKUP/uploads.tar.gz" > "$BACKUP/uploads.list"
dc run --rm --no-deps -T -e LOG_LEVEL=silent -v "$PKG/config:/ops:ro" --entrypoint node app /ops/snapshot.cjs > "$BACKUP/before.json"
(cd "$BACKUP" && sha256sum installation.tar.gz runtime.env database.dump uploads.tar.gz app-image.tar.gz > SHA256SUMS)
printf '%s\n' "$ROOT" "$PKG" "$BACKUP" > "$STAGE/paths.txt"
```

Ожидается остановка без принудительного SIGKILL (exit 137 — остановиться и
разобраться с незавершённой обработкой). Дамп и архивы читаются, before.json
содержит очередь и ID/закрепления. Данные в очереди НЕ очищаются.
Если любой шаг неуспешен — приложение не обновлять; устранить причину резервной
копии либо вернуть старое `dc start app` и выполнить `bash "$PKG/config/wait-ready.sh"`. Не продолжать с непроверенным дампом.
Эта копия содержит секреты и данные; не отправлять её в GitHub/чат.

## 3. Заменить исходники и добавить только три настройки

```bash
rsync -a --checksum --delete --exclude='.env*' --exclude='app-runtime.env' --exclude='data/' --exclude='node_modules/' --exclude='dist/' --exclude='.git/' --exclude='docker-compose.override.yml' "$PKG/project/" "$ROOT/project/"
# Частный set-status-env.py не опубликован. Вручную согласуйте и задайте
# в существующем .env только BOT_STATUS_USER_IDS, BOT_STATUS_TIME, BOT_STATUS_WEEKDAY.
# Значение BOT_STATUS_USER_IDS берите из своего окружения: <STATUS_RECIPIENT_IDS>.
sha256sum "$ROOT/project/.env" > "$BACKUP/updated-env.sha256"
```

В исходном пакете помощник изменял только BOT_STATUS_USER_IDS=<STATUS_RECIPIENT_IDS>,
BOT_STATUS_TIME=08:00, BOT_STATUS_WEEKDAY=monday. Другие значения .env сохраняются;
env_file читает их при пересоздании. Получателю нужно открыть личный диалог
с их ботом. В шаблоне получатели по-прежнему пусты. Пароли/токены не выводятся.
Копия старого project находится в installation.tar.gz. Если замена файлов или ручная настройка завершились
ошибкой — не запускать приложение, выполнить откат файлов (раздел 7).

## 4. Собрать точную версию и проверить её до запуска

```bash
cd "$ROOT/project"
dc -f "$PKG/config/build-label.yml" build app > "$BACKUP/build.log" 2>&1
# До пересоздания dc images показывает образ старого контейнера. Проверяем новый тег сборки:
docker image inspect incident-bot-app --format 'image={{.Id}} revision={{index .Config.Labels "org.opencontainers.image.revision"}}'
test "$(docker image inspect incident-bot-app --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = 377b8b7837037e8aaad4e98530d02588f086edb2
dc run --rm --no-deps -T -e LOG_LEVEL=silent --entrypoint node app -e 'const c=require("./dist/config").getConfig(); if(c.NODE_ENV!=="production"||c.BOT_MODE!=="webhook"||c.WEBHOOK_AUTO_REGISTER!==false)process.exit(1); console.log("Configuration OK; secret values omitted")'
dc run --rm --no-deps -T --entrypoint sh app -c 'npx prisma migrate status' > "$BACKUP/migrations.log" 2>&1
dc run --rm --no-deps -T -e LOG_LEVEL=silent -v "$PKG/config:/ops:ro" --entrypoint node app /ops/snapshot.cjs --offline > "$BACKUP/after-offline.json"
dc run --rm --no-deps -T -v "$PKG/config:/ops:ro" -v "$BACKUP:/backup:ro" --entrypoint node app /ops/compare.cjs /backup/before.json /backup/after-offline.json --offline
```

Ожидается label с указанным полным хешем, Configuration OK, миграции применены,
compare ok=true. Команды run выше запускают только проверки, не index.js, не бот.
При любой ошибке приложение не запускать. Сборку повторить после устранения
сетевого сбоя; при ошибке конфигурации исправить только установленную причину.

В PR нет новых миграций. Отдельный migrate deploy не нужен: штатная команда
Compose уже вызывает его при запуске, при актуальной схеме это пустая операция.
Если migrate status обнаружил pending/divergent migration — остановиться,
уточнить установленную версию; не применять неизвестные миграции автоматически.
PostgreSQL, Caddy и MinIO пересоздавать/перезапускать не требуется.

## 5. Пересоздать только приложение и проверить

```bash
dc up -d --no-deps --no-build --force-recreate app
APP=$(dc ps -q app)
RUN_IMAGE=$(docker inspect "$APP" --format '{{.Image}}')
docker image inspect "$RUN_IMAGE" --format 'running-image={{.Id}} revision={{index .Config.Labels "org.opencontainers.image.revision"}}'
test "$(docker image inspect "$RUN_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = 377b8b7837037e8aaad4e98530d02588f086edb2
bash "$PKG/config/wait-ready.sh"
dc ps
dc logs --since 10m --no-color app > "$BACKUP/app-after.log" 2>&1
dc run --rm --no-deps -T -e LOG_LEVEL=silent -v "$PKG/config:/ops:ro" --entrypoint node app /ops/snapshot.cjs > "$BACKUP/after.json"
dc run --rm --no-deps -T -v "$PKG/config:/ops:ro" -v "$BACKUP:/backup:ro" --entrypoint node app /ops/compare.cjs /backup/before.json /backup/after.json
```

wait-ready.sh ждёт health=200 и ready=200 до 120 секунд. При превышении срока
возвращает код 1 и понятную ошибку; дальше не продолжать. Одна попытка ограничена
8 секундами (принудительное завершение через дополнительную секунду). /ready проверяется
из контейнера: типовой Caddy не публикует этот путь, внешняя 404 на /ready ожидаема.
Ожидаются неизменные panel IDs, соответствие фактическому закреплению и набору
кнопок, webhook.expectedPresent=true. Сравниваются все текущие панели, не только
фиксированное число. after.json содержит сводные состояния inbox/outbox: свежий
PENDING нормален, FAILED и зависшие PROCESSING/SENDING требуют разбора; сравнить
с before.json. Новые сообщения после запуска могут закономерно менять счётчик,
пользователей и данные — каждое отличие compare нужно объяснить, не игнорировать.
Логи просмотреть локально, не пересылать целиком: в них могут быть данные.
Вебхук остаётся прежним; регистрацию и отправку `doctor --send` не выполнять.
Если подписка/панели изменились неожиданно, новые ошибки растут или версия неверна —
остановить app, сохранить after.json/логи и выполнить раздел 7. Не сбрасывать ID.

## 6. Живой прогон после автоматических проверок

В согласованном тестовом диалоге с их ботом:

1. /start и «Начать»: новый текст и меню без раздела обработки данных.
2. Новый черновик: номер в тексте принимается; ФИО/документы по-прежнему запрещены.
3. На предпросмотре «📞 Поделиться контактом»: свой подписанный контакт добавляется,
   ложного отказа нет, карточка обновляется, кнопка исчезает. До «✅ Всё верно»
   нового INC быть не должно. «Исправить → Убрать номер» возвращает предложение.
4. Повторно добавить контакт и подтвердить один раз: один новый номер, повторное
   нажатие/событие не создаёт второе сообщение. Отдельный номер не виден в общих
   карточках; доступен только по прежним полномочиям. Проверить также отправку без номера.
5. Отмена и следующий черновик: старые действия не меняют отменённый черновик;
   следующий начинается без телефона. Ограничение MAX: старая штатная кнопка
   контакта во время нового допустимого черновика не содержит ID исходной кнопки.
6. В распределении, профильном чате и согласовании взять тестовую карточку:
   16:41 МСК + 15 минут = 16:56 МСК (либо фактическое время +15). Сверить имя и
   освобождение, не менять системные часы. Проверить подтверждение ответа и возврат.

Фиксировать результат отдельно от автоматических тестов. Наши проверки пакета
не заменяют этот живой прогон. Не отправлять пробный недельный отчёт получателю.

## 7. Откат приложения без потери новых данных

В той же оболочке BACKUP указывает на сделанную копию. После переподключения
явно задать BACKUP полным проверенным путём; не выбирать «последний» автоматически.

```bash
cd "$HOME/incident-transfer/project"
dc () { docker compose -p incident-bot -f docker-compose.yml "$@"; }
dc stop -t 75 app
dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$BACKUP/before-rollback-current.dump"
dc run --rm --no-deps -T --user root --entrypoint tar app -czf - -C /app/data/uploads . > "$BACKUP/before-rollback-current-uploads.tar.gz"
ROLLBACK_FILES=$(mktemp -d "$HOME/incident-rollback.XXXXXX")
tar -xzf "$BACKUP/installation.tar.gz" -C "$ROLLBACK_FILES"
rsync -a --checksum --delete --exclude='.env*' --exclude='app-runtime.env' --exclude='data/' --exclude='node_modules/' --exclude='dist/' --exclude='.git/' --exclude='docker-compose.override.yml' "$ROLLBACK_FILES/incident-transfer/project/" "$HOME/incident-transfer/project/"
cp -p .env "$BACKUP/env-before-rollback"
cp -p "$BACKUP/runtime.env" .env
gzip -dc "$BACKUP/app-image.tar.gz" | docker image load > "$BACKUP/load-image.log"
ROLLBACK_TAG=$(cat "$BACKUP/rollback-tag.txt")
docker tag "$ROLLBACK_TAG" incident-bot-app:latest
dc up -d --no-deps --no-build --force-recreate app
APP=$(dc ps -q app)
test "$(docker inspect "$APP" --format '{{.Image}}')" = "$(cat "$BACKUP/old-image-id.txt")"
bash "$PKG/config/wait-ready.sh"
```

База и вложения остаются ТЕКУЩИМИ, в том числе созданными после обновления.
Бэкап database.dump при обычном откате НЕ восстанавливать: это потеряло бы новые
данные. Схема не менялась. Повторить проверку webhook/панелей скриптом snapshot
из сохранённого PKG, просмотреть очереди и логи. При обнаруженном повреждении
данных сначала отдельный разбор и согласование восстановления с учётом новых
событий; не подменять БД старым дампом вслепую. Откат приложения не восстанавливает
сообщения, удалённые в MAX отдельной очисткой.
