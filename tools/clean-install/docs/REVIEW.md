# Clean-host handover review

Pinned main c41f2d532591ddeb2ce0ea3d217e8a1a2095f38a and reserve3c5c38b0f6477d5124593406f09f3af4c2db0c12; no rebuilds.
Scripts reviewed dependencies are byte-for-byte40967e2. This controller uses a NEW clean-host state,
not the source migration/install receipts. Scripts must run as the approved local administrator.
Production use requires review of successful test evidence and the separate private evening plan.
Never run any bot against production DB/token during staging. Never delete a failed operation ledger.

init: new empty directory, exact image IDs, generated private role credentials and Compose.
infra: only PostgreSQL and Caddy, no app. Caddy /handover-check returns an operation challenge.
restore: only new empty DB; full final backup checksums, genuine source verification and source-fence
required. Restores current schema without migration, checks NEW schema including two CRLF pairs,
all data fingerprints and every file. Does not import old installation receipts.
start: requires fresh source-stop confirmation, exact config/identity, no second app, retained policy,
first-start data recheck and bounded readiness. A start attempt means target may have new data.
stop: SIGTERM, <=75s, no SIGKILL, clean exit/graceful log and same container required.
start --role reserve: only after confirmed stopped state or known failed creation/start; current DB.
abandon: only before ANY target start attempt, permanently prevents this target operation starting.
Unknown create/start/stop/restore state is a refusal; do not delete state or create another operation to bypass it.
If readiness times out with a running app, inspect private diagnostics; stop is permitted from start-intent,
then select reserve only for a confirmed defect it can address. No automatic replay or old DB rollback.

The target may receive new messages/perform background work before HTTP readiness. After any start
attempt never resume an old source database. Gracefully stop target, capture/verify CURRENT target
DB/files and reverse-transfer into a new source location; keep old source DB only as evidence.
Cross-host mutual exclusion requires the two operators' confirmed source fence; one host cannot
cryptographically prove the other host stayed off. Do not claim the source-fence JSON alone prevents
an administrator from manually restarting source. Unknown source state is a stop condition.

Target PostgreSQL/Caddy data, images/containerd data and application files must reside on approved
persistent storage. docker info DockerRootDir alone does not attest containerd storage location.
No global prune, no docker compose down -v, no direct containerd file changes.

Evidence is synthetic Docker/Linux, not certification of Astra patches, MAC labels, external ACME,
public DNS, MAX TLS/media egress or NAT hairpin. Those are mandatory on-site preflight checks.

The source seal also captures the actual stopped container effective environment into a separate
0600 effective-runtime.env, bound by SHA256 in the envelope. This preserves Compose overrides
without guessing from runtime.env alone. It is PRIVATE FINAL DATA, never part of the program ZIP.
The target only replaces documented infrastructure settings; no shell sourcing/interpolation.


## Дополнение эксплуатационного комплекта

Новая редакция добавляет только операции хоста: проверенный ежедневный архив (без внешней выдачи), явно разрешаемое восстановление того же CID, systemd шаблоны, внешний GET-контроль и подключение обратного переноса к существующей сети Caddy. Runtime, SQL/миграции, образы и девять reviewed-зависимостей 40967e2 неизменны. Старый программный ZIP и исходный протокол сохраняются отдельно.

Смотрите новый review/report.json и environment.txt: заявлять успешность только при passed=true. Новые проверки используют настоящие Docker/PostgreSQL, synthetic MAX, системный flock и systemd. Управляемая ошибка pg_dump и изменение recovery-clock — тестовые инъекции; не выдаются за реальные производственные отказы. Проверка restart Docker daemon не заменяет физическую перезагрузку Astra; публичный ACME, реальный DNS/сеть MAX и MAC Astra остаются принимающему специалисту. Доставка уведомлений внешнему дежурному не настроена: предоставлен checker, канал и интеграция отдельно.

Закрытый архив ежедневной копии не зашифрован и содержит конфигурацию/секреты. Это намеренно отдельный этап от шифрования и выдачи: без общего доступа, без HTTP, без автоудаления. Root/sudo остаётся границей доверия. Межсерверное отсутствие второго экземпляра обеспечивается согласованными действиями двух операторов, а не переносимым разрешением из архива.
