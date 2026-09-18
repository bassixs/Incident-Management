import { ResponsibleGroupKind } from '@prisma/client';
import { RESPONSIBLE_GROUPS } from './catalog';

/** Full public names; routing buttons and editable group titles stay separate. */
const FULL_AUTHORITIES: Record<string, string> = {
  REGION_KALUGA: 'Администрация Губернатора Калужской области',
  REGION_DEFENDERS: 'Фонд защитников Отечества',
  REGION_SOCIAL_FUND: 'Социальный фонд',
  EA_INTERNAL_POLICY: 'Министерство внутренней политики Калужской области',
  EA_TRANSPORT: 'Министерство транспорта Калужской области',
  EA_HEALTH: 'Министерство здравоохранения Калужской области',
  EA_COMPETITION: 'Министерство конкурентной политики Калужской области',
  EA_CULTURE_TOURISM: 'Министерство культуры и туризма Калужской области',
  EA_EDUCATION: 'Министерство образования и науки Калужской области',
  EA_NATURE: 'Министерство природных ресурсов и экологии Калужской области',
  EA_AGRICULTURE: 'Министерство сельского хозяйства Калужской области',
  EA_SPORT: 'Министерство спорта Калужской области',
  EA_CONSTRUCTION: 'Министерство строительства и жилищно-коммунального хозяйства Калужской области',
  EA_LABOR: 'Министерство труда и социальной защиты Калужской области',
  EA_FINANCE: 'Министерство финансов Калужской области',
  EA_DIGITAL: 'Министерство цифрового развития Калужской области',
  EA_ECONOMY: 'Министерство экономического развития и промышленности Калужской области',
  EA_GZHI: 'Государственная жилищная инспекция Калужской области',
  EA_UATK: 'Управление административно-технического контроля Калужской области',
  EA_ZAGS: 'Управление записи актов гражданского состояния Калужской области',
  EA_ARCHIVES: 'Управление по делам архивов Калужской области',
  EA_CULTURAL_HERITAGE: 'Управление по охране объектов культурного наследия Калужской области',
  EA_ARCHITECTURE: 'Управление архитектуры и градостроительства Калужской области',
  EA_VETERINARY: 'Комитет ветеринарии при Правительстве Калужской области',
  EA_YOUTH: 'Управление молодежной политики Калужской области',
  EA_GOSSTROYNADZOR: 'Инспекция государственного строительного надзора Калужской области',
};

const INSTRUMENTAL_PREFIXES = [
  ['Администрация ', 'Администрацией '],
  ['Министерство ', 'Министерством '],
  ['Государственная жилищная инспекция ', 'Государственной жилищной инспекцией '],
  ['Управление ', 'Управлением '],
  ['Комитет ', 'Комитетом '],
  ['Инспекция ', 'Инспекцией '],
  ['Фонд ', 'Фондом '],
  ['Социальный фонд', 'Социальным фондом'],
] as const;

const signaturesByName = new Map<string, string>();
for (const group of RESPONSIBLE_GROUPS) {
  const fullName = group.kind === ResponsibleGroupKind.LOCAL_GOVERNMENT
    ? group.authorityName! : FULL_AUTHORITIES[group.code];
  if (!fullName) throw new Error(`Missing authority name for ${group.code}`);
  const prefix = INSTRUMENTAL_PREFIXES.find(([from]) => fullName.startsWith(from));
  if (!prefix) throw new Error(`Missing answer signature for ${group.code}`);
  const instrumental = prefix[1] + fullName.slice(prefix[0].length);
  for (const alias of [group.name, group.authorityName, fullName, instrumental]) {
    if (alias) signaturesByName.set(alias, instrumental);
  }
}
// Existing settings may still contain the original short regional name.
signaturesByName.set('Калужская область', 'Администрацией Губернатора Калужской области');

/** Respect disabled/custom signatures; only decline the known organization names. */
export function answerSignature(authorityName?: string | null): string | null {
  const name = authorityName?.trim();
  if (!name) return null;
  const instrumental = signaturesByName.get(name);
  return instrumental ? `Ответ подготовлен ${instrumental}.` : `Ответ подготовлен:\n${name}`;
}
