export type ProblemLocality = {
  code: string;
  name: string;
};

export type ProblemMunicipality = {
  code: string;
  name: string;
  localities: ProblemLocality[];
};

/**
 * Территории показываются заявителю в этом порядке. Коды являются стабильными:
 * по ним бот связывает выбор пользователя с рекомендуемой ответственной группой.
 */
export const PROBLEM_MUNICIPALITIES: ProblemMunicipality[] = [
  { code: 'KALUGA_REGION', name: 'Калужская область (общий вопрос)', localities: [] },
  { code: 'KALUGA_CITY', name: 'Город Калуга', localities: [] },
  { code: 'OBNINSK_CITY', name: 'Город Обнинск', localities: [] },
  {
    code: 'BOROVSKY',
    name: 'Боровский округ',
    localities: [
      { code: 'BALABANOVO', name: 'Балабаново' },
      { code: 'BOROVSK', name: 'Боровск' },
      { code: 'ERMOLINO', name: 'Ермолино' },
    ],
  },
  {
    code: 'DZERZHINSKY',
    name: 'Дзержинский округ',
    localities: [
      { code: 'KONDROVO', name: 'Кондрово' },
      { code: 'TOVARKOVO', name: 'Товарково' },
      { code: 'PYATOVSKY', name: 'Пятовский' },
      { code: 'POLOTNYANY_ZAVOD', name: 'Полотняный Завод' },
      { code: 'LEV_TOLSTOY', name: 'Льва Толстого' },
    ],
  },
  {
    code: 'ZHUKOVSKY',
    name: 'Жуковский округ',
    localities: [
      { code: 'ZHUKOV', name: 'Жуков' },
      { code: 'BELOUSOVO', name: 'Белоусово' },
      { code: 'KREMENKI', name: 'Кременки' },
    ],
  },
  {
    code: 'KIROVSKY',
    name: 'Кировский округ',
    localities: [
      { code: 'KIROV', name: 'Киров' },
      { code: 'SHAYKOVKA', name: 'Шайковка' },
    ],
  },
  {
    code: 'LYUDINOVSKY',
    name: 'Людиновский округ',
    localities: [
      { code: 'LYUDINOVO', name: 'Людиново' },
      { code: 'ZARECHNY', name: 'Заречный' },
      { code: 'BUKAN', name: 'Букань' },
    ],
  },
  {
    code: 'MALOYAROSLAVETSKY',
    name: 'Малоярославецкий округ',
    localities: [
      { code: 'MALOYAROSLAVETS', name: 'Малоярославец' },
      { code: 'DETCHINO', name: 'Детчино' },
    ],
  },
  {
    code: 'BABYNINSKY',
    name: 'Бабынинский округ',
    localities: [
      { code: 'BABYNINO', name: 'Бабынино' },
      { code: 'VOROTYNSK', name: 'Воротынск' },
    ],
  },
  {
    code: 'BARYATINSKY',
    name: 'Барятинский округ',
    localities: [
      { code: 'BARYATINO', name: 'Барятино' },
      { code: 'MIRNY', name: 'Мирный' },
    ],
  },
  {
    code: 'DUMINICHSKY',
    name: 'Думиничский округ',
    localities: [
      { code: 'DUMINICHI', name: 'Думиничи' },
      { code: 'NOVOSLOBODSK', name: 'Новослободск' },
    ],
  },
  {
    code: 'ZHIZDRINSKY',
    name: 'Жиздринский округ',
    localities: [
      { code: 'ZHIZDRA', name: 'Жиздра' },
      { code: 'KOLLEKTIVIZATOR', name: 'Совхоз «Коллективизатор»' },
    ],
  },
  {
    code: 'IZNOSKOVSKY',
    name: 'Износковский округ',
    localities: [
      { code: 'IZNOSKI', name: 'Износки' },
      { code: 'MYATLEVO', name: 'Мятлево' },
    ],
  },
  {
    code: 'KOZELSKY',
    name: 'Козельский округ',
    localities: [
      { code: 'KOZELSK', name: 'Козельск' },
      { code: 'SOSENSKY', name: 'Сосенский' },
    ],
  },
  {
    code: 'KUYBYSHEVSKY',
    name: 'Куйбышевский район',
    localities: [
      { code: 'BETLITSA', name: 'Бетлица' },
      { code: 'BUTCHINO', name: 'Бутчино' },
    ],
  },
  {
    code: 'MEDYNSKY',
    name: 'Медынский округ',
    localities: [{ code: 'MEDYN', name: 'Медынь' }],
  },
  {
    code: 'MESHCHOVSKY',
    name: 'Мещовский округ',
    localities: [
      { code: 'MESHCHOVSK', name: 'Мещовск' },
      { code: 'SERPEYSK', name: 'Серпейск' },
    ],
  },
  {
    code: 'MOSALSKY',
    name: 'Мосальский округ',
    localities: [{ code: 'MOSALSK', name: 'Мосальск' }],
  },
  {
    code: 'PEREMYSHLSKY',
    name: 'Перемышльский округ',
    localities: [{ code: 'PEREMYSHL', name: 'Перемышль' }],
  },
  {
    code: 'SPAS_DEMENSKY',
    name: 'Спас-Деменский округ',
    localities: [{ code: 'SPAS_DEMENSK', name: 'Спас-Деменск' }],
  },
  {
    code: 'SUKHINICHSKY',
    name: 'Сухиничский округ',
    localities: [
      { code: 'SUKHINICHI', name: 'Сухиничи' },
      { code: 'SEREDEYSKY', name: 'Середейский' },
    ],
  },
  {
    code: 'TARUSSKY',
    name: 'Тарусский округ',
    localities: [
      { code: 'TARUSA', name: 'Таруса' },
      { code: 'ILYINSKOE', name: 'Ильинское' },
    ],
  },
  {
    code: 'ULYANOVSKY',
    name: 'Ульяновский округ',
    localities: [
      { code: 'ULYANOVO', name: 'Ульяново' },
      { code: 'ZARECHYE', name: 'Заречье' },
      { code: 'DUDOROVSKY', name: 'Дудоровский' },
    ],
  },
  {
    code: 'FERZIKOVSKY',
    name: 'Ферзиковский округ',
    localities: [
      { code: 'FERZIKOVO', name: 'Ферзиково' },
      { code: 'OKTYABRSKY', name: 'Октябрьский' },
    ],
  },
  {
    code: 'KHVASTOVICHSKY',
    name: 'Хвастовичский округ',
    localities: [
      { code: 'KHVASTOVICHI', name: 'Хвастовичи' },
      { code: 'ELENSKY', name: 'Еленский' },
    ],
  },
  {
    code: 'YUKHNOVSKY',
    name: 'Юхновский округ',
    localities: [
      { code: 'YUKHNOV', name: 'Юхнов' },
      { code: 'SHCHELKANOVO', name: 'Щелканово' },
    ],
  },
];

export function findProblemMunicipality(code: string): ProblemMunicipality | undefined {
  return PROBLEM_MUNICIPALITIES.find((item) => item.code === code);
}

export function findProblemLocality(
  municipality: ProblemMunicipality,
  code: string,
): ProblemLocality | undefined {
  return municipality.localities.find((item) => item.code === code);
}
