// Passive handover checks. Never import index/container or call MAX mutations.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

class Diagnostic extends Error {
  constructor(code, message, next) { super(message); this.code = code; this.next = next; }
}
const fail = (code, message, next) => { throw new Diagnostic(code, message, next); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function redact(text, env) {
  let result = String(text);
  const secrets = ['BOT_TOKEN', 'WEBHOOK_SECRET', 'POSTGRES_PASSWORD', 'DATABASE_URL', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']
    .map(key => env[key]).filter(Boolean);
  try { secrets.push(decodeURIComponent(new URL(env.DATABASE_URL).password)); } catch {}
  for (const value of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const variant of new Set([value, encodeURIComponent(value)])) result = result.split(variant).join('[REDACTED]');
  }
  return result;
}

function diagnostic(error, stage) {
  if (error instanceof Diagnostic) return error;
  // Codes are allowlisted; never print message/stack/meta/response from a library.
  const codes = [error?.errorCode, error?.code, error?.meta?.code, error?.cause?.code];
  const has = (...values) => values.some(value => codes.includes(value));
  // Prisma initialization failures can omit errorCode. Recognize only fixed
  // engine signatures; the message itself must never leave this function.
  const message = typeof error?.message === 'string' ? error.message : '';
  if (stage.startsWith('database')) {
    if (has('P1000', '28P01', '28000') || /Authentication failed against database server|password authentication failed/i.test(message)) return new Diagnostic('DB_AUTH', 'PostgreSQL отклонил авторизацию.', 'Сверьте POSTGRES_USER и действующий пароль роли. Изменение .env не меняет пароль в существующем томе; том не удалять.');
    if (has('P1001', 'P1002', 'P1008', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN') || /Can't reach database server|Connection refused|Timed out fetching a new connection/i.test(message)) return new Diagnostic('DB_UNREACHABLE', 'Нет соединения с PostgreSQL или истекло время ожидания.', 'Проверьте dc ps postgres, тот же Compose-проект/сеть и узел postgres:5432; не localhost.');
    if (has('P1003', '3D000')) return new Diagnostic('DB_NOT_FOUND', 'Указанная база не существует.', 'Уточните имя реально созданной базы в POSTGRES_DB. Не импортируйте дамп поверх другой базы.');
    if (has('P1010', '42501')) return new Diagnostic('DB_PERMISSION', 'Недостаточно прав роли PostgreSQL.', 'Попросите администратора БД проверить доступ указанной роли к восстановленной базе.');
    if (has('P1013')) return new Diagnostic('CONFIG_DATABASE_URL', 'Неверный формат подключения к БД.', 'Сверьте POSTGRES_* и DATABASE_URL; Compose вставляет пароль без URL-кодирования.');
    if (has('P2021', '42P01')) return new Diagnostic('DB_TABLES_MISSING', 'В базе отсутствуют необходимые таблицы.', 'Для новой пустой установки сначала восстановите data/database.dump по START-HERE, затем check database. При частичной/рабочей базе не повторяйте импорт вслепую.');
    return new Diagnostic('DB_ERROR', 'Проверка БД не завершилась; небезопасные подробности скрыты.', 'Проверьте check connection и журнал PostgreSQL у администратора; не передавайте пароли, URL или дамп в публичную переписку.');
  }
  if (stage.startsWith('MAX')) {
    const status = error?.status ?? error?.response?.status;
    if (status === 401) return new Diagnostic('MAX_AUTH_401', 'MAX отклонил токен (HTTP 401).', 'Проверьте токен нового бота. Authorization содержит сам токен, без префикса Bearer. Токен не присылайте.');
    if (status === 403 || status === 404) return new Diagnostic('MAX_ACCESS_' + status, 'MAX не разрешил доступ к ресурсу (HTTP ' + status + ').', 'Проверьте ID нового бота, членство в чате, права администратора и доступность сообщения.');
    if (status === 429 || [500, 502, 503, 504].includes(status)) return new Diagnostic('MAX_TEMPORARY_' + status, 'Временная ошибка MAX (HTTP ' + status + ').', 'Повторите проверку позже; не меняйте токен или привязки из-за временной ошибки.');
    if (has('CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT')) return new Diagnostic('MAX_TLS', 'Не удалось проверить TLS-сертификат MAX.', 'Проверьте CA-монтирование и NODE_EXTRA_CA_CERTS из Compose; не отключайте проверку TLS.');
    return new Diagnostic('MAX_NETWORK', 'Не удалось завершить запрос к MAX; ответ и секреты скрыты.', 'Проверьте DNS/HTTPS к platform-api2.max.ru, время сервера и CA; повторите проверку.');
  }
  return new Diagnostic('CONFIG_APP', 'Не удалось прочитать или проверить настройки приложения.', 'Проверьте имена и допустимые значения в .env.example; не выводите .env или полный Compose config.');
}

function formatDiagnostic(error, stage, env) {
  const d = diagnostic(error, stage);
  return redact(`FAIL [${stage}] ${d.code}: ${d.message}\nДалее: ${d.next}`, env);
}

async function run({ mode = 'env', expected, appRoot = '/app', packageRoot = path.resolve(__dirname, '..'), env = process.env, output = console, dependencies } = {}) {
  let prisma, stage = 'configuration';
  // Library logging/debug can contain server replies. The checker emits only its own allowlisted diagnostics.
  process.env.LOG_LEVEL = 'silent';
  process.env.DEBUG = '';
  const req = dependencies?.require ?? createRequire(path.join(appRoot, 'package.json'));
  const info = text => output.log(redact(text, env));
  const file = relative => {
    try { return fs.readFileSync(path.join(packageRoot, relative), 'utf8'); }
    catch { fail('PACKAGE_FILE_MISSING', `В комплекте отсутствует или недоступен ${relative}.`, 'Проверьте распаковку полного архива и монтирование PACKAGE:/handover:ro; не создавайте пустые файлы.'); }
  };
  const jsonFile = relative => { try { return JSON.parse(file(relative)); } catch (e) { if (e instanceof Diagnostic) throw e; fail('PACKAGE_FILE_INVALID', `Некорректный файл ${relative}.`, 'Проверьте SHA256SUMS и используйте полный исходный комплект.'); } };
  try {
    if (!['env', 'connection', 'database', 'identity', 'chats', 'panels'].includes(mode)) fail('CONFIG_MODE', 'Неизвестный режим проверки.', 'Доступны env, connection, database, identity, chats, panels.');
    const switches = { NODE_ENV: 'production', BOT_MODE: 'webhook', WEBHOOK_AUTO_REGISTER: 'false' };
    if (Object.entries(switches).some(([key, value]) => env[key] !== value)) {
      const actual = Object.entries(switches).map(([key, value]) => `${key}: фактически ${JSON.stringify(env[key] ?? '<не задано>')}, ожидается ${JSON.stringify(value)}`).join('\n');
      fail('CONFIG_MODE_VALUES', actual, 'Исправьте эти строки в используемом .env, сохраните и повторите check env с теми же параметрами dc. Сборка образа не нужна.');
    }
    const required = ['BOT_TOKEN', 'PUBLIC_DOMAIN', 'WEBHOOK_URL', 'WEBHOOK_SECRET', 'POSTGRES_USER', 'POSTGRES_DB', 'POSTGRES_PASSWORD', 'DATABASE_URL', 'DISTRIBUTION_CHAT_ID', 'REVIEW_CHAT_ID'];
    const missing = required.filter(key => !env[key]?.trim());
    if (missing.length) fail('CONFIG_MISSING', 'Не заполнены: ' + missing.join(', '), 'Заполните переменные по .env.example до запуска PostgreSQL. Для существующего тома используйте его действующие реквизиты.');
    const placeholders = required.filter(key => /REPLACE_WITH|YOUR_DOMAIN\.example/.test(env[key]));
    if (placeholders.length) fail('CONFIG_PLACEHOLDER', 'Остались заглушки: ' + placeholders.join(', '), 'Подставьте свои значения. Секреты не присылайте и не публикуйте.');
    if (!/^[a-zA-Z0-9_]+$/.test(env.POSTGRES_USER) || !/^[a-zA-Z0-9_]+$/.test(env.POSTGRES_DB)) fail('CONFIG_DB_NAMES', 'POSTGRES_USER/POSTGRES_DB: требуются буквы латиницы, цифры или _.', 'Сверьте реальные имена роли/базы; не переименовывайте существующую БД без согласования.');
    if (!/^[a-zA-Z0-9_-]{20,}$/.test(env.POSTGRES_PASSWORD)) fail('CONFIG_DB_PASSWORD', 'POSTGRES_PASSWORD: минимум 20 символов; латинские буквы, цифры, _ и -.', 'Это правило установочного комплекта и URL-подстановки Compose. Для нового тома задайте пароль до первого запуска. Для существующего согласуйте смену пароля роли через psql \\password, затем обновите .env; том не удалять.');
    let dbUrl;
    try { dbUrl = new URL(env.DATABASE_URL); }
    catch { fail('CONFIG_DATABASE_URL', 'Некорректный DATABASE_URL; значение скрыто.', 'Сверьте формат с шаблоном. Compose формирует URL из POSTGRES_*.'); }
    if (!['postgres:', 'postgresql:'].includes(dbUrl.protocol) || dbUrl.hostname !== 'postgres' || (dbUrl.port || '5432') !== '5432' || decodeURIComponent(dbUrl.username) !== env.POSTGRES_USER || decodeURIComponent(dbUrl.password) !== env.POSTGRES_PASSWORD || decodeURIComponent(dbUrl.pathname.slice(1)) !== env.POSTGRES_DB) fail('CONFIG_DATABASE_URL', 'DATABASE_URL не согласован с POSTGRES_* или адресом postgres:5432.', 'Используйте внутреннее имя postgres и порт 5432. Сохраните те же параметры Compose, которыми запускаете приложение.');
    let config;
    try { config = req('./dist/config').loadConfig({ ...env, LOG_LEVEL: 'silent' }); }
    catch { fail('CONFIG_APP', 'Настройки не прошли схему приложения.', 'Проверьте числовые параметры, ID, часовой пояс, URL, версии/хеши документов по .env.example. Секретные значения скрыты.'); }
    if (config.MAX_API_BASE_URL.replace(/\/+$/, '') !== 'https://platform-api2.max.ru') fail('CONFIG_MAX_URL', 'Для этого комплекта ожидается https://platform-api2.max.ru.', 'Проверьте MAX_API_BASE_URL. TLS-проверку не отключать.');
    if (config.MEDIA_STORAGE !== 'local' || config.mediaLocalAbsolutePath !== '/app/data/uploads') fail('CONFIG_MEDIA', 'Требуется local-хранилище /app/data/uploads.', 'Сверьте MEDIA_STORAGE, MEDIA_LOCAL_PATH и том uploads в Compose.');
    const url = new URL(config.WEBHOOK_URL);
    if (url.protocol !== 'https:' || url.host !== env.PUBLIC_DOMAIN || url.pathname !== config.WEBHOOK_PATH || url.search || url.hash || url.username || url.password) fail('CONFIG_WEBHOOK_URL', 'PUBLIC_DOMAIN, WEBHOOK_URL и WEBHOOK_PATH не согласованы.', 'PUBLIC_DOMAIN — ваш домен без протокола; WEBHOOK_URL — https://ваш-домен/webhook/max.');
    if (config.LOG_PRETTY || config.DAILY_INCIDENT_LIMIT !== 3 || config.INCIDENT_MAX_LENGTH !== 150 || config.LEGAL_CONSENT_REQUIRED) fail('CONFIG_WORKFLOW', 'Параметры рабочего сценария расходятся с установочным шаблоном.', 'Проверьте LOG_PRETTY=false, DAILY_INCIDENT_LIMIT=3, INCIDENT_MAX_LENGTH=150, LEGAL_CONSENT_REQUIRED=false.');
    if (!config.LEGAL_DOCUMENTS_BASE_URL || new URL(config.LEGAL_DOCUMENTS_BASE_URL).host !== url.host) fail('CONFIG_DOCUMENTS_URL', 'Не задан адрес документов на вашем домене.', 'Укажите LEGAL_DOCUMENTS_BASE_URL=https://ваш-домен/documents.');
    const reference = req('dotenv').parse(file('config/business-settings.env'));
    if (['DISTRIBUTION_CHAT_ID', 'REVIEW_CHAT_ID', 'DELIVERY_ALERT_CHAT_ID'].some(key => (env[key] || '') !== (reference[key] || ''))) fail('CONFIG_CHAT_BINDINGS', 'ID рабочих чатов расходятся с переданным снимком.', 'Сверьте config/business-settings.env; смену чатов согласуйте до запуска, привязки автоматически не сбрасываются.');
    info('Environment: OK (secret values omitted)');
    if (mode === 'env') return 0;
    if (['connection', 'database'].includes(mode)) {
      stage = 'database/connection';
      prisma = dependencies?.prisma ?? new (req('@prisma/client').PrismaClient)({ log: [] });
      await prisma.$queryRawUnsafe('SELECT 1');
      info('Database connection: OK (postgres:5432)');
      if (mode === 'connection') return 0;
      stage = 'database/schema';
      const manifest = jsonFile('data/prepared-manifest.json');
      if (!Array.isArray(manifest) || manifest.length !== 26 || manifest.some(row => !['public', 'handover_archive'].includes(row.schema) || !/^[_a-zA-Z]+$/.test(row.table) || !Number.isInteger(row.count) || !/^[a-f0-9]{32}$/.test(row.digest))) fail('PACKAGE_MANIFEST', 'Некорректный манифест восстановленной базы.', 'Проверьте SHA256SUMS; используйте manifest и data/database.dump из одного комплекта.');
      const tables = await prisma.$queryRawUnsafe("SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','handover_archive')");
      if (!tables.length) fail('DB_EMPTY', 'Подключение успешно, но база пустая: таблицы приложения отсутствуют.', 'При чистой установке выполните раздел «Восстановление data/database.dump» в START-HERE.md, затем повторите check database. Не запускайте app раньше восстановления.');
      const missingTables = manifest.filter(row => !tables.some(t => t.schemaname === row.schema && t.tablename === row.table));
      if (missingTables.length) fail('DB_TABLES_MISSING', `Не хватает ${missingTables.length} таблиц ожидаемой схемы.`, 'Проверьте результат восстановления data/database.dump и имя базы. Сохраните существующие данные; не повторяйте импорт поверх частичной или рабочей базы.');
      stage = 'database/data';
      for (const row of manifest) {
        const [actual] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count, md5(coalesce(string_agg(h,'' ORDER BY h),'')) AS digest FROM (SELECT md5(row_to_json(t)::text) h FROM "${row.schema}"."${row.table}" t) s`);
        if (actual.count !== row.count || actual.digest !== row.digest) fail('DB_DATA_MISMATCH', `Данные таблицы ${row.schema}.${row.table} не совпадают со снимком.`, 'Эта сверка предназначена только для начального восстановления до запуска app. Если бот уже работал, изменения ожидаемы: не восстанавливайте старый дамп, используйте check connection и штатные проверки.');
      }
      stage = 'database/migrations';
      const migrations = await prisma.$queryRawUnsafe('SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations"');
      for (const m of migrations) {
        if (!/^\d{14}_[a-zA-Z0-9_-]+$/.test(m.migration_name)) fail('DB_MIGRATIONS', 'Неожиданная запись миграции.', 'Сверьте код и восстановленную базу, не применяйте reset.');
        let s; try { s = fs.readFileSync(path.join(appRoot, 'prisma/migrations', m.migration_name, 'migration.sql'), 'utf8'); } catch { fail('DB_MIGRATIONS', 'Нет файла миграции для восстановленной базы.', 'Проверьте, что образ собран из project/ этого комплекта.'); }
        const lf = s.replace(/\r\n/g, '\n');
        if (!m.finished_at || m.rolled_back_at || ![s, lf, lf.replace(/\n/g, '\r\n')].some(v => hash(v) === m.checksum)) fail('DB_MIGRATIONS', 'Состояние или контрольная сумма миграции не совпадает.', 'Сверьте код и снимок с комплектом; не запускайте приложение до разбора.');
      }
      for (const t of ['InboundUpdate', 'OutboundMessage']) {
        const [r] = await prisma.$queryRawUnsafe(`SELECT (SELECT last_value FROM "${t}_sequence_seq")>=coalesce(max(sequence),0) AS ok FROM "${t}"`);
        if (!r.ok) fail('DB_SEQUENCE', 'Последовательность БД отстаёт от сохранённых записей.', 'Передайте код ошибки администратору БД; данные не очищать.');
      }
      info(`Database: ${manifest.length} tables match; migrations ${migrations.length}; active old transport absent`);
      return 0;
    }
    stage = 'MAX/identity';
    const max = dependencies?.max ?? req('./dist/max/max-client').createMaxClient(new (req('@maxhub/max-bot-api').Bot)(config.BOT_TOKEN, { clientOptions: { baseUrl: config.MAX_API_BASE_URL } }));
    const me = await max.getMe();
    info('Bot ID: ' + me.user_id);
    if (String(me.user_id) === '391053284') fail('MAX_OLD_BOT', 'Используется токен старого бота.', 'Замените BOT_TOKEN на токен нового бота Минцифры.');
    if (mode === 'identity') return 0;
    if (!/^\d+$/.test(expected || '') || String(me.user_id) !== expected) fail('MAX_ID_MISMATCH', 'Не указан или не совпадает ожидаемый ID нового бота.', 'Сверьте ID в MAX и передайте его: check chats ID / check panels ID.');
    const subscriptions = await max.listWebhookSubscriptions();
    if (mode === 'chats' && subscriptions.length) fail('MAX_EXISTING_WEBHOOK', 'У нового бота уже есть подписка вебхука.', 'Проверьте её URL штатной командой webhook-info. Согласованно отключите прежнюю подписку этого нового бота до чистой установки.');
    const groups = jsonFile('config/chat-bindings.json');
    const ids = [...new Set([reference.DISTRIBUTION_CHAT_ID, reference.REVIEW_CHAT_ID, reference.DELIVERY_ALERT_CHAT_ID, ...groups.filter(g => g.isActive && g.maxChatId != null).map(g => String(g.maxChatId))].filter(Boolean))];
    const own = req('./dist/max/pinned-panel.service').isOwnQueuePanel;
    if (mode === 'panels') prisma = dependencies?.prisma ?? new (req('@prisma/client').PrismaClient)({ log: [] });
    let count = 0;
    for (const id of ids) {
      stage = 'MAX/chat';
      const member = await max.api.getChatMembership(Number(id));
      if (!member.is_admin || !(member.permissions === null || member.permissions?.includes('write'))) fail('MAX_CHAT_RIGHTS', `Недостаточно прав бота в чате ${id}.`, 'Нужны права администратора/отправки, доступ к истории и закреплению.');
      if (id === reference.DELIVERY_ALERT_CHAT_ID) continue;
      const distribution = id === reference.DISTRIBUTION_CHAT_ID;
      if (mode === 'chats') {
        let before = Date.now() + 1000, complete = false;
        const candidates = new Set();
        for (let page = 0; page < 10; page++) {
          const history = await max.getChatMessages(BigInt(id), before);
          history.messages.filter(m => own(m, BigInt(id), me.user_id, distribution)).forEach(m => candidates.add(m.body.mid));
          const oldest = Math.min(...history.messages.map(m => m.timestamp));
          if (history.messages.length < 100) { complete = true; break; }
          if (oldest >= before) break;
          before = oldest;
        }
        if (!complete) fail('MAX_HISTORY_LIMIT', `Не удалось полностью проверить историю чата ${id}.`, 'Осмотрите панели вручную до запуска; не сбрасывайте ID и не создавайте дубли вслепую.');
        info(`Chat ${id}: admin/write/history OK; own panel candidates ${candidates.size}`);
      } else {
        stage = 'database/panel-index';
        const setting = await prisma.systemSetting.findUnique({ where: { key: (distribution ? 'distribution-panel:' : 'work-panel:') + id } });
        if (!setting) fail('PANEL_MISSING', `Нет ID панели для чата ${id}.`, 'Дождитесь штатного обновления очередей после запуска; проверьте outbox и журналы.');
        stage = 'MAX/panel';
        const m = await max.getMessage(setting.value), pin = await max.getPinnedMessage(BigInt(id));
        if (!own(m, BigInt(id), me.user_id, distribution) || pin.message?.body.mid !== setting.value) fail('PANEL_IDENTITY', `Не совпадают автор/закрепление панели чата ${id}.`, 'Проверьте панель и права нового бота; сообщения старого бота автоматически исправленными не считать.');
        const buttons = (m.body.attachments || []).filter(a => a.type === 'inline_keyboard').flatMap(a => a.payload.buttons.flat());
        const wanted = distribution ? ['personal:home', 'queue:next', 'queue:list:0', 'queue:refresh', 'work:today:0'] : ['personal:home', 'work:next', 'work:list:0', 'work:mine:0', 'work:today:0', 'work:refresh'];
        if (wanted.some(v => !buttons.some(b => b.type === 'callback' && b.payload === v))) fail('PANEL_BUTTONS', `Не хватает кнопок панели чата ${id}.`, 'Проверьте штатное обновление панели и outbox.');
        info(`Panel ${id}: database ID, owner, pin and button payloads OK`);
      }
      count++;
    }
    if (count !== 54) fail('PACKAGE_CHAT_COUNT', 'Число чатов с панелями не равно 54.', 'Сверьте конфигурацию и привязки этого снимка; автоматический сброс запрещён.');
    info(`Checked ${ids.length} working chats / ${count} panel chats; no test messages sent`);
    return 0;
  } catch (e) {
    output.error(formatDiagnostic(e, stage, env));
    return 1;
  } finally {
    if (prisma) try { await prisma.$disconnect(); } catch { output.error('FAIL [database/disconnect] DB_DISCONNECT: соединение не закрыто штатно; повторите проверку.'); return 1; }
  }
}

module.exports = { run, Diagnostic, diagnostic, formatDiagnostic };
if (require.main === module) run({ mode: process.argv[2], expected: process.argv[3] }).then(code => { process.exitCode = code; });
