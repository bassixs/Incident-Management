from pathlib import Path, PurePosixPath
import hashlib, json, re, shutil, subprocess, tarfile, zipfile
from urllib.parse import urlparse, unquote

REV = '7dded197aa4b1bded85867ac4b47a7da4415e44d'
BASE = '0e6ac397d8c133488edd435b6a621670be44cdd0'
out = Path('output/update-20260930')
root = out / 'Na-svyazi-region40'
project = root / 'project'
verification = root / 'verification'
project.mkdir(parents=True, exist_ok=True)
verification.mkdir(exist_ok=True)
source = Path('tmp/handover-source-7dded19.tar.gz')
sha = lambda b: hashlib.sha256(b).hexdigest()
assert sha(source.read_bytes()) == 'f7405ad07ec2f810556995ad04f8290213dcc15d6b513a0bdfed152113c41eee'
with tarfile.open(source) as t:
    assert t.pax_headers['comment'] == REV
    members = t.getmembers()
    for m in members:
        assert (m.isfile() or m.isdir()) and not PurePosixPath(m.name).is_absolute() and '..' not in PurePosixPath(m.name).parts
    t.extractall(project, filter='data')
unchanged = ['package.json', 'package-lock.json', 'Dockerfile', 'docker-compose.yml', 'prisma/schema.prisma', 'prisma/migrations']
assert not subprocess.check_output(['git', 'diff', '--name-only', BASE, REV, '--', *unchanged], text=True).strip()
shutil.copyfile(source, root / 'repository-source.tar.gz')
(verification / 'source-revision.txt').write_text(REV+'\n', encoding='ascii')
source_manifest = {p.relative_to(project).as_posix(): sha(p.read_bytes()) for p in sorted(project.rglob('*')) if p.is_file()}
assert len(source_manifest) == 312
(verification / 'source-manifest.json').write_text(json.dumps(source_manifest, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')

readme = r'''# Обновление «На связи_регион40» — 30.09.2026

Коммит: **7dded197aa4b1bded85867ac4b47a7da4415e44d** (main).
Это обновление существующей установки. Внутри — `project/`, Git-снимок `repository-source.tar.gz`, `verification/` и `SHA256SUMS`. Базы, вложений, рабочего `.env`, `app-runtime.env`, готовых `dist`, `node_modules` и Docker-образов здесь нет. Приложение собирается привычной командой Docker.

**Сначала уточните установленную у вас версию. Она нам точно неизвестна.** Посмотрите прежний `verification/source-revision.txt`, записи установки и image labels. Отсутствие label не доказывает версию; при необходимости сравните файлы. Относительно **0e6ac39** не изменились зависимости (`package.json`, `package-lock.json`), Dockerfile, основной Compose, схема БД и все 21 миграция. Если установлен другой код, есть локальные доработки либо отличия схемы — согласуйте их до применения команд ниже. Установка без этой сверки не предполагается.

## 1. Проверить архив и текущую установку

Распакуйте обновление в отдельную папку, не поверх работающего проекта. Пример ниже — Bash; нужны Docker Compose v2, unzip, rsync и доступ к источникам Docker-сборки. Укажите свои пути. Сохраняйте существующее имя Compose-проекта и его дополнительные `-f`/`--env-file`, если они применялись: новое имя создаст другие тома.

```bash
set -euo pipefail
umask 077
# Из каталога, куда доставлены ZIP и соседний .sha256:
sha256sum -c Na-svyazi-region40-update-2026-09-30.zip.sha256
mkdir -p "$HOME/incident-update-20260930"
unzip Na-svyazi-region40-update-2026-09-30.zip -d "$HOME/incident-update-20260930"
UPDATE="$HOME/incident-update-20260930/Na-svyazi-region40"
INSTALL="$HOME/incident-transfer/project"  # заменить, если ваш путь другой
(cd "$UPDATE" && sha256sum -c SHA256SUMS)
cd "$INSTALL"
# Это функция из прежней инструкции. Если у вас другая команда — сохранить вашу.
dc() { docker compose -p incident-bot -f docker-compose.yml "$@"; }
dc config --quiet
APP=$(dc ps -q app)
test -n "$APP"
docker inspect "$APP" --format 'project={{index .Config.Labels "com.docker.compose.project"}} image={{.Image}} revision={{index .Config.Labels "org.opencontainers.image.revision"}}'
```

Убедитесь, что это нужная работающая установка. Сверьте локальные настройки Docker/прокси и схему; не выводите содержимое `.env` в переписку. Не копируйте `.env.example` поверх своего `.env`. Не выполняйте `seed`, reset/cleanup или `docker compose down -v`.

## 2. Резервная копия и остановка ВАШЕГО приложения на время обновления

Согласуйте короткое окно. Команды не относятся к прежнему серверу отправителя. Сохраните права/настройки чатов и не меняйте токен, домен, вебхук. Убедитесь, что во время снимка нет других писателей БД/вложений, включая внешние задачи обслуживания. Ниже вариант для PostgreSQL и local uploads штатного Compose; при S3 нужен отдельный снимок вашего бакета.

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="$(dirname "$INSTALL")/backups/update-$STAMP"
mkdir -p "$BACKUP"
OLD_IMAGE=$(docker inspect "$APP" --format '{{.Image}}')
ROLLBACK_IMAGE="incident-update-rollback:$STAMP"
docker tag "$OLD_IMAGE" "$ROLLBACK_IMAGE"
docker image save "$ROLLBACK_IMAGE" | gzip > "$BACKUP/previous-image.tar.gz"
printf '%s\n' "$ROLLBACK_IMAGE" > "$BACKUP/previous-image.txt"
tar --exclude='./node_modules' --exclude='./dist' --exclude='./.git' --exclude='./data' --exclude='./backups' -czf "$BACKUP/project-before.tar.gz" .
sha256sum .env > "$BACKUP/env-before.sha256"
dc stop app
test "$(docker inspect "$APP" --format '{{.State.Running}}')" = false
dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$BACKUP/database.dump"
docker run --rm --network none --volumes-from "$APP":ro --entrypoint sh "$OLD_IMAGE" -c 'tar -czf - -C /app/data/uploads .' > "$BACKUP/uploads.tar.gz"
test -s "$BACKUP/database.dump"
dc exec -T postgres pg_restore --list < "$BACKUP/database.dump" > "$BACKUP/dump-contents.txt"
tar -tzf "$BACKUP/uploads.tar.gz" > "$BACKUP/upload-files.txt"
(cd "$BACKUP" && sha256sum project-before.tar.gz previous-image.tar.gz database.dump uploads.tar.gz > SHA256SUMS)
```

Сохраните путь BACKUP. Копия содержит ВАШИ настройки и данные, храните её закрыто. При ошибке остановитесь; не продолжайте обновление без проверенной копии. `pg_restore --list` проверяет читаемость дампа, но не заменяет полноценную пробу восстановления в отдельной базе.

## 3. Обновить файлы, собрать и запустить

Настройки Docker и прокси ниже намеренно сохраняются: с указанной базовой версией они не менялись. Если ваша версия отличается, сначала завершите сверку из п. 1. Старый `src/` переносится в резервную папку, чтобы удалённые из нового релиза исходники не остались при наложении файлов. Содержимое базы/томов не заменяется.

```bash
mv src "$BACKUP/src-before"
rsync -a --exclude='/.env*' --exclude='/Dockerfile' --exclude='/docker-compose*.yml' --exclude='/docker-compose*.yaml' --exclude='/compose*.yml' --exclude='/compose*.yaml' --exclude='/deploy/' "$UPDATE/project/" "$INSTALL/"
sha256sum -c "$BACKUP/env-before.sha256"
dc build app
dc up -d --no-deps --no-build app
```

Это тот же Docker build: зависимости устанавливаются через `npm ci`, `dist` создаётся внутри образа. В штатном Compose при старте выполняется `prisma migrate deploy`; относительно 0e6ac39 новых миграций нет. PostgreSQL, Caddy и тома не пересоздаются. Архив содержит актуальные документы; если Минцифры меняла их реквизиты локально, согласуйте изменения до копирования `legal/`. Изменённый локально `deploy/` сохраняется.

## 4. Проверки

```bash
dc ps app
dc exec -T app node -e 'Promise.all(["health","ready"].map(async p=>{const r=await fetch("http://127.0.0.1:3000/"+p,{signal:AbortSignal.timeout(5000)});console.log(p,r.status);if(!r.ok)process.exitCode=1})).catch(()=>{console.error("health/ready failed");process.exitCode=1})'
dc exec -T app node dist/scripts/webhook-info.js
dc exec -T app node dist/scripts/doctor.js
dc logs --since 10m --tail 200 app
sha256sum -c "$BACKUP/env-before.sha256"
docker inspect "$(dc ps -q app)" --format '{{.Image}}' > "$BACKUP/installed-image.txt"
cp "$UPDATE/verification/source-revision.txt" "$BACKUP/installed-source-revision.txt"
```

Health/ready должны вернуть 200. Проверить ваш HTTPS-домен, ожидаемый вебхук, отсутствие ошибочных/зависших inbox/outbox, актуальность панелей и совпадение ID с закреплениями. Плановые обновления панелей допустимы. `doctor` выполнять **без `--send`**. Обычно регистрировать или удалять вебхук при таком обновлении не требуется: домен и бот сохраняются. Простой doctor проверяет хранилище временным файлом; не запускает тестовые отправки в чаты. Живые кнопки/контакт проверять отдельно на согласованных тестовых данных, не на рабочих сообщениях жителей.

## 5. Откат приложения при ошибке

Используйте сохранённые BACKUP/INSTALL и ту же функцию dc. Новую БД поверх старой не восстанавливать: после запуска могли появиться данные. Этот откат применим после подтверждения совместимости схемы в п. 1.

```bash
dc stop app
ROLLBACK_IMAGE=$(cat "$BACKUP/previous-image.txt")
docker image inspect "$ROLLBACK_IMAGE" >/dev/null 2>&1 || docker image load -i "$BACKUP/previous-image.tar.gz"
mkdir "$BACKUP/rollback-project"
tar -xzf "$BACKUP/project-before.tar.gz" -C "$BACKUP/rollback-project"
# Если новый src ещё не появился после сбоя копирования, переносить нечего.
if [ -d src ]; then mv src "$BACKUP/src-failed"; fi
rsync -a --exclude='/.env*' --exclude='/Dockerfile' --exclude='/docker-compose*.yml' --exclude='/docker-compose*.yaml' --exclude='/compose*.yml' --exclude='/compose*.yaml' --exclude='/deploy/' "$BACKUP/rollback-project/" "$INSTALL/"
printf 'services:\n  app:\n    image: %s\n' "$ROLLBACK_IMAGE" > "$BACKUP/rollback.yml"
dc -f "$BACKUP/rollback.yml" up -d --no-deps --no-build app
```

Повторите проверки из п. 4. Сохраните запись об используемом rollback.yml; не удаляйте прежний образ. Ваш `.env`, БД и вложения остаются текущими. Если были изменения схемы либо требуется восстановление данных, сначала остановить запись и сохранить всё появившееся после обновления; восстановление старого дампа без сверки недопустимо.

## Отдельно: панели от другого бота

Если ранее вы восстановили нашу базу, но используете другого бота MAX, в ней могли остаться ID панелей и карточек прежнего бота. Обновление исходников само по себе их не переносит. До запуска проверьте автора панелей и сохранённые ID. При расхождении согласуйте точечный порядок исправления с сохранением ваших данных. Автоматический сброс привязок, очистка очередей, мигратор и смена бота в этот пакет не входят.

Для обновления начинайте с этого START-HERE.md. Исторические инструкции первоначального развёртывания в project/ оставлены в составе точного Git-снимка; их шаги восстановления чужой базы и смены вебхука здесь не выполняются.
'''
(root / 'START-HERE.md').write_text(readme, encoding='utf-8', newline='\n')

# Scan known secrets locally; never print their values and never copy these files.
known = set()
for file in [Path('.env'), Path('tmp/handover-20260929-v2/package/project/.env'), Path('tmp/handover-20260929-v2/package/config/app-runtime.env')]:
    if not file.is_file(): continue
    for line in file.read_text(encoding='utf-8-sig').splitlines():
        if line.startswith('#') or '=' not in line: continue
        key,value=line.split('=',1); value=value.strip().strip('"\'')
        if re.search(r'TOKEN|SECRET|PASSWORD|ACCESS_KEY',key) and len(value)>=8 and 'REPLACE_' not in value: known.add(value.encode())
        if key=='DATABASE_URL':
            password=unquote(urlparse(value).password or '')
            if len(password)>=8: known.add(password.encode())
patterns=[rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',rb'gh[pousr]_[A-Za-z0-9]{30,}',rb'AKIA[0-9A-Z]{16}']
hits=[]
for p in root.rglob('*'):
    if not p.is_file(): continue
    data=p.read_bytes()
    if any(secret in data for secret in known) or any(re.search(pattern,data) for pattern in patterns): hits.append(p.relative_to(root).as_posix())
assert not hits, f'Secret scan needs review: {hits}'
check={'packageType':'application-update-only','sourceRevision':REV,'comparisonRevision':BASE,'unchangedSinceComparison':unchanged,
       'sourceFiles':len(source_manifest),'knownSecretValuesChecked':len(known),'secretMatches':hits,
       'includesDatabase':False,'includesUploads':False,'includesRuntimeEnvironment':False,'includesBuiltDist':False,'includesNodeModules':False,'includesDockerImages':False,
       'deploymentMethod':'existing Docker Compose; build app, recreate only app','installedRecipientVersion':'unknown: verify before applying',
       'productionServerAccessedForThisTask':False,'migrationToolIncluded':False}
(verification/'package-check.json').write_text(json.dumps(check,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
entries={p.relative_to(root).as_posix():sha(p.read_bytes()) for p in sorted(root.rglob('*')) if p.is_file() and p.name!='SHA256SUMS'}
(root/'SHA256SUMS').write_text(''.join(f'{digest}  {name}\n' for name,digest in entries.items()),encoding='utf-8',newline='\n')
archive=out/'Na-svyazi-region40-update-2026-09-30.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for p in sorted(root.rglob('*')):
        if p.is_file(): z.write(p,'Na-svyazi-region40/'+p.relative_to(root).as_posix())
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    assert all(n.startswith('Na-svyazi-region40/') for n in z.namelist())
    for name,digest in entries.items(): assert sha(z.read('Na-svyazi-region40/'+name))==digest,name
    for name,digest in source_manifest.items(): assert sha(z.read('Na-svyazi-region40/project/'+name))==digest,name
    for name in z.namelist():
        rel=name.removeprefix('Na-svyazi-region40/')
        assert not rel.startswith(('data/','config/','project/data/','project/dist/','project/node_modules/','.git/'))
        assert PurePosixPath(rel).name not in ['.env','app-runtime.env','incident.dump','database.dump','uploads.tar.gz']
archive_hash=sha(archive.read_bytes())
archive.with_suffix('.zip.sha256').write_text(archive_hash+'  '+archive.name+'\n',encoding='ascii')
print(json.dumps({'archive':str(archive.resolve()),'bytes':archive.stat().st_size,'files':len(entries)+1,'sha256':archive_hash,**check},ensure_ascii=False,indent=2))
