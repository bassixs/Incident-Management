# Восстановление доступности после передачи

Автозапуск приложения из Compose остаётся `restart=no`. До завершения передачи он запрещён. Механизм ниже запускает только прежний полный CID на этом же хосте, не пересоздаёт приложение, не меняет БД/очередь/образ/вебхук. Хэш конфигурации контейнера, identity и схема БД, settings, единственность токена и локальная host-ownership проверяются перед восстановлением. Копирование operations.json на другой хост не разрешает там запуск. Но межсерверную эксклюзивность по-прежнему подтверждают два оператора; доступ администратора вне инструмента технически не заблокирован.

## Включить только ПОСЛЕ передачи и проверки

В root-shell с точными ROOT, KIT, HANDOFF из этой операции:

```bash
python3 "$KIT/scripts/operations.py" --root "$ROOT" backup --manual
python3 "$KIT/scripts/operations.py" --root "$ROOT" enable --confirm-handover-complete "$HANDOFF"
python3 "$KIT/scripts/operations.py" --root "$ROOT" units
PROJECT=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["project"])' "$ROOT/settings.json")
# Просмотреть все четыре файла. install относится только к этому случайному PROJECT.
for ACTION in backup supervise; do
  for KIND in service timer; do
    test ! -e "/etc/systemd/system/${PROJECT}-${ACTION}.${KIND}" || exit 1
    install -m 0644 "$ROOT/service-units/${PROJECT}-${ACTION}.${KIND}" /etc/systemd/system/
  done
done
systemd-analyze verify "/etc/systemd/system/${PROJECT}-backup.service" "/etc/systemd/system/${PROJECT}-backup.timer" "/etc/systemd/system/${PROJECT}-supervise.service" "/etc/systemd/system/${PROJECT}-supervise.timer"
systemctl daemon-reload
systemctl enable --now "${PROJECT}-backup.timer" "${PROJECT}-supervise.timer"
```

`units` не устанавливает и не включает сервисы. Условия enable: оператор подтверждает завершение передачи и ограждение другого хоста, текущая готовность и точная схема, свежая проверенная копия с совпадающим SHA. Полные пути фиксируются в ExecStart: старый KIT нельзя удалить, пока units ссылаются на него. Смена пути/редакции — отдельное ревью. Повторное `units` отказывает, не затирает файлы. Проверить актуальное время/NTP, Docker boot enable и systemd на Astra. Не копировать старые enabled-состояния/установочные receipts.

## Поведение

Раз в 30 секунд, после boot не раньше 60 секунд: GET /health и /ready, результат в `$ROOT/state/availability.json` и журнале `${PROJECT}-supervise.service`. При работающем, но неготовом контейнере — UNAVAILABLE, ненулевой exit, **без слепого рестарта**. При точно exited — проверка identity/schema и запуск того же CID. Не более трёх попыток за час, минимум пять минут между попытками, намерение записывается до docker start. Проверка готовности ограничена 120 сек. Неизвестный результат/изменённый контейнер/второй экземпляр — отказ для разбора. Lock busy — пропуск без ложного вывода о падении. Во время полной проверки резервной копии восстановление этим механизмом ждёт освобождения lock.

Неизвестное состояние Docker, исчезнувший CID, повреждённый state, изменение image/config, ошибка PG/схемы автоматически не исправляются. Для зацикленного падения сначала диагностика; не удалять attempts, не включать общий restart policy, не пересоздавать. На выключенном сервере локальный контроль ничего не сообщает.

Отдельно с другой машины: `python3 check-external.py --url https://ДОМЕН`. Проверяет сертификат и два GET, exit 0=UP, 2=UNAVAILABLE. Подключить к согласованному внешнему мониторингу/дежурному (канал уведомления и исполнитель ещё должны быть подтверждены). Это контроль, а не уже настроенная внешняя служба оповещения. Самодоступ публичного домена из контейнера не является единственным тестом внешнего webhook.

## ПЕРЕД любой остановкой/возвратом

```bash
python3 "$KIT/scripts/operations.py" --root "$ROOT" disable
systemctl disable --now "${PROJECT}-backup.timer" "${PROJECT}-supervise.timer"
# Убедиться, что oneshot backup/supervise уже завершён; не убивать процесс копирования.
python3 "$KIT/scripts/clean.py" --root "$ROOT" stop
```

Если backup.lock занят — дождаться штатного завершения, повторно прочитать статус. clean stop сам сначала записывает disabled, до SIGTERM. Остановка без этого инструмента может быть воспринята как падение! Оставшийся boot-таймер при disabled не запустит app. start/abandon тоже снимают разрешение. После явного переключения основная/резерв автозапуск нужно подтвердить заново, он не включается автоматически.

Проверено на синтетическом Linux runner: настоящий crash контейнера, реальный restart Docker daemon, запуск systemd oneshot, fence после stop, backoff/лимит, второй экземпляр, HTTP outage и блокировка. Это НЕ проверка физической перезагрузки Astra или её MAC-политик. Проверку reboot целевого хоста проводить только по отдельному разрешению после передачи, с готовым оператором и согласованным окном.

Сравнение inspect учитывает только два воспроизведённых варианта представления: порядок Mounts (сортировка по Destination) и null/[] трёх Dns/DnsSearch/DnsOptions. Значения не игнорируются. [Moby v28.0.4 readHostConfig/InitDNSHostConfig](https://github.com/moby/moby/blob/v28.0.4/container/container.go) подтверждает преобразование пустых DNS-полей при чтении после restart. Остальные различия приводят к отказу.
