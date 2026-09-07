import { ResponsibleGroupKind } from '@prisma/client';

export type ResponsibleGroupSeed = {
  code: string;
  name: string;
  kind: ResponsibleGroupKind;
  maxChatId: bigint;
  municipalityCode?: string;
  authorityName?: string;
  bypassReview?: boolean;
};

const regional = (
  code: string,
  name: string,
  maxChatId: bigint,
  municipalityCode?: string,
  bypassReview = false,
): ResponsibleGroupSeed => ({
  code,
  name,
  kind: ResponsibleGroupKind.REGIONAL,
  maxChatId,
  municipalityCode,
  bypassReview,
});

/** Full chat title / answer signature; routing keeps the short municipality name. */
export function localAdministrationTitle(name: string): string {
  if (name === 'Город Калуга') return 'Администрация города Калуги';
  if (name === 'Город Обнинск') return 'Администрация города Обнинска';
  const match = /^(.+)ий (округ|район)$/.exec(name);
  if (!match) throw new Error('Unexpected local municipality name: ' + name);
  return 'Администрация ' + match[1] + 'ого ' + (match[2] === 'округ' ? 'округа' : 'района');
}

const local = (
  code: string,
  name: string,
  maxChatId: bigint,
  municipalityCode: string,
): ResponsibleGroupSeed => ({
  code,
  name,
  kind: ResponsibleGroupKind.LOCAL_GOVERNMENT,
  authorityName: localAdministrationTitle(name),
  maxChatId,
  municipalityCode,
});

const executive = (code: string, name: string, maxChatId: bigint): ResponsibleGroupSeed => ({
  code,
  name,
  kind: ResponsibleGroupKind.EXECUTIVE_AUTHORITY,
  maxChatId,
});

/** Зафиксированный пользователем перечень из 50 профильных чатов. */
export const RESPONSIBLE_GROUPS: ResponsibleGroupSeed[] = [
  regional('REGION_KALUGA', 'Калужская область', -78347547385914n, 'KALUGA_REGION', true),

  local('LG_BABYNINSKY', 'Бабынинский округ', -78339541704762n, 'BABYNINSKY'),
  local('LG_BARYATINSKY', 'Барятинский округ', -78347519270970n, 'BARYATINSKY'),
  local('LG_BOROVSKY', 'Боровский округ', -78347583430714n, 'BOROVSKY'),
  local('LG_KALUGA_CITY', 'Город Калуга', -78344795004986n, 'KALUGA_CITY'),
  local('LG_OBNINSK_CITY', 'Город Обнинск', -78344672059450n, 'OBNINSK_CITY'),
  local('LG_DZERZHINSKY', 'Дзержинский округ', -78347616526394n, 'DZERZHINSKY'),
  local('LG_DUMINICHSKY', 'Думиничский округ', -78347487354938n, 'DUMINICHSKY'),
  local('LG_ZHIZDRINSKY', 'Жиздринский округ', -78347446067258n, 'ZHIZDRINSKY'),
  local('LG_ZHUKOVSKY', 'Жуковский округ', -78347408711738n, 'ZHUKOVSKY'),
  local('LG_IZNOSKOVSKY', 'Износковский округ', -78347367489594n, 'IZNOSKOVSKY'),
  local('LG_KIROVSKY', 'Кировский округ', -78347321548858n, 'KIROVSKY'),
  local('LG_KOZELSKY', 'Козельский округ', -78347277377594n, 'KOZELSKY'),
  local('LG_KUYBYSHEVSKY', 'Куйбышевский район', -78347236483130n, 'KUYBYSHEVSKY'),
  local('LG_LYUDINOVSKY', 'Людиновский округ', -78347197816890n, 'LYUDINOVSKY'),
  local('LG_MALOYAROSLAVETSKY', 'Малоярославецкий округ', -78347154825274n, 'MALOYAROSLAVETSKY'),
  local('LG_MEDYNSKY', 'Медынский округ', -78344994365498n, 'MEDYNSKY'),
  local('LG_MESHCHOVSKY', 'Мещовский округ', -78344957075514n, 'MESHCHOVSKY'),
  local('LG_MOSALSKY', 'Мосальский округ', -78344918540346n, 'MOSALSKY'),
  local('LG_PEREMYSHLSKY', 'Перемышльский округ', -78344880791610n, 'PEREMYSHLSKY'),
  local('LG_SPAS_DEMENSKY', 'Спас-Деменский округ', -78344840159290n, 'SPAS_DEMENSKY'),
  local('LG_SUKHINICHSKY', 'Сухиничский округ', -78344714133562n, 'SUKHINICHSKY'),
  local('LG_TARUSSKY', 'Тарусский округ', -78341985280058n, 'TARUSSKY'),
  local('LG_ULYANOVSKY', 'Ульяновский округ', -78341943140410n, 'ULYANOVSKY'),
  local('LG_FERZIKOVSKY', 'Ферзиковский округ', -78339531415610n, 'FERZIKOVSKY'),
  local('LG_KHVASTOVICHSKY', 'Хвастовичский округ', -78540154609722n, 'KHVASTOVICHSKY'),
  local('LG_YUKHNOVSKY', 'Юхновский округ', -78540182331450n, 'YUKHNOVSKY'),

  executive('EA_INTERNAL_POLICY', 'Министерство внутренней политики', -78540262744122n),
  executive('EA_TRANSPORT', 'Министерство транспорта', -78540295643194n),
  executive('EA_HEALTH', 'Министерство здравоохранения', -78540333064250n),
  executive('EA_COMPETITION', 'Министерство конкурентной политики', -78540368191546n),
  executive('EA_CULTURE_TOURISM', 'Министерство культуры и туризма', -78540395061306n),
  executive('EA_EDUCATION', 'Министерство образования и науки', -78541146824762n),
  executive('EA_NATURE', 'Министерство природных ресурсов и экологии', -78541177495610n),
  executive('EA_AGRICULTURE', 'Министерство сельского хозяйства', -78541205741626n),
  executive('EA_SPORT', 'Министерство спорта', -78541235036218n),
  executive('EA_CONSTRUCTION', 'Министерство строительства и ЖКХ', -78541262430266n),
  executive('EA_LABOR', 'Министерство труда и социальной защиты', -78541293690938n),
  executive('EA_FINANCE', 'Министерство финансов', -78541323968570n),
  executive('EA_DIGITAL', 'Министерство цифрового развития', -78541348479034n),
  executive('EA_ECONOMY', 'Министерство экономического развития', -78541370695738n),
  executive('EA_GZHI', 'ГЖИ', -78541410148410n),
  executive('EA_UATK', 'УАТК', -78541435707450n),
  executive('EA_ZAGS', 'ЗАГС', -78541700735034n),
  executive('EA_ARCHIVES', 'Управление по делам архивов', -78541740843066n),
  executive(
    'EA_CULTURAL_HERITAGE',
    'Управление по охране объектов культурного наследия',
    -78541767450682n,
  ),
  executive('EA_ARCHITECTURE', 'Управление архитектуры и градостроительства', -78541797204026n),
  executive('EA_VETERINARY', 'Комитет ветеринарии', -78541827219514n),
  executive('EA_YOUTH', 'Управление молодежной политики', -78541851336762n),
  executive('EA_GOSSTROYNADZOR', 'Госстройнадзор', -78541877878842n),
];
