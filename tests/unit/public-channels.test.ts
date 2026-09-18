import { describe, expect, it } from 'vitest';
import { RESPONSIBLE_GROUPS } from '../../src/responsible-groups/catalog';
import { publicChannelFor } from '../../src/responsible-groups/public-channels';

// Independently listed destinations from the owner's channel list.
const expected: Array<[string, string]> = [
  ['LG_BABYNINSKY', 'id4000028966_gos'], ['LG_BARYATINSKY', 'id4000029141_gos'],
  ['LG_BOROVSKY', 'id4000028684_gos'], ['LG_KALUGA_CITY', 'id4027017947_gos'],
  ['LG_OBNINSK_CITY', 'obninsk_today'], ['LG_DZERZHINSKY', 'id4000028638_gos'],
  ['LG_DUMINICHSKY', 'id4000028437_gos'], ['LG_ZHIZDRINSKY', 'id4000029127_gos'],
  ['LG_ZHUKOVSKY', 'id4000028451_gos'], ['LG_IZNOSKOVSKY', 'id4000029021_gos'],
  ['LG_KIROVSKY', 'id4000028268_gos'], ['LG_KOZELSKY', 'id4000028839_gos'],
  ['LG_KUYBYSHEVSKY', 'id4010000021_gos'], ['LG_LYUDINOVSKY', 'id4000028564_gos'],
  ['LG_MALOYAROSLAVETSKY', 'id4000028356_gos'], ['LG_MEDYNSKY', 'id4000028589_gos'],
  ['LG_MESHCHOVSKY', 'id4000028677_gos'], ['LG_MOSALSKY', 'id4000029247_gos'],
  ['LG_PEREMYSHLSKY', 'id4000028412_gos'], ['LG_SPAS_DEMENSKY', 'id4000029046_gos'],
  ['LG_SUKHINICHSKY', 'channel_suhadm'], ['LG_TARUSSKY', 'id4000029166_gos'],
  ['LG_ULYANOVSKY', 'id4000029938_gos'], ['LG_FERZIKOVSKY', 'id4000028892_gos'],
  ['LG_KHVASTOVICHSKY', 'id4000028740_gos'], ['LG_YUKHNOVSKY', 'id4000028772_gos'],
  ['EA_INTERNAL_POLICY', 'id4027116024_gos'], ['EA_TRANSPORT', 'mintrans40'],
  ['EA_HEALTH', 'minzdrav40'], ['EA_COMPETITION', 'id4027078890_gos'],
  ['EA_CULTURE_TOURISM', 'minkult_40'], ['EA_EDUCATION', 'minobr_40'],
  ['EA_NATURE', 'id4029045065_gos'], ['EA_AGRICULTURE', 'id4027064295_gos'],
  ['EA_SPORT', 'minsporta_40'], ['EA_CONSTRUCTION', 'minstroy_40'],
  ['EA_LABOR', 'kalugaoblmintrud'], ['EA_FINANCE', 'id4027064190_gos'],
  ['EA_DIGITAL', 'id4027138814_gos'], ['EA_ECONOMY', 'id4027064200_gos'],
  ['EA_GZHI', 'id4027064312_gos'], ['EA_UATK', 'id4029044858_gos'],
  ['EA_ZAGS', 'id4027060438_gos'], ['EA_ARCHIVES', 'id4027018203_gos'],
  ['EA_CULTURAL_HERITAGE', 'id4028060590_gos'], ['EA_ARCHITECTURE', 'id4027103378_gos'],
  ['EA_VETERINARY', 'id4027019207_gos'], ['EA_YOUTH', 'id4028073454_gos'],
];

describe('subscription channels for responsible organizations', () => {
  it.each(expected)('%s points to the supplied MAX channel', (code, slug) => {
    expect(RESPONSIBLE_GROUPS.some(group => group.code === code)).toBe(true);
    expect(publicChannelFor(code)?.url).toBe(`https://max.ru/${slug}`);
  });
  it('covers 48 organizations, leaving organizations without a supplied channel unset', () => {
    expect(expected).toHaveLength(48);
    expect(new Set(expected.map(([code]) => code)).size).toBe(48);
    expect(RESPONSIBLE_GROUPS.filter(group => !publicChannelFor(group.code)).map(group => group.code))
      .toEqual(['REGION_KALUGA', 'REGION_DEFENDERS', 'REGION_SOCIAL_FUND', 'EA_GOSSTROYNADZOR']);
    expect(publicChannelFor('unknown')).toBeUndefined();
    expect(publicChannelFor(null)).toBeUndefined();
  });
  it('uses full public organization names on buttons', () => {
    for (const group of RESPONSIBLE_GROUPS.filter(group => group.code.startsWith('LG_'))) {
      expect(publicChannelFor(group.code)?.name).toBe(group.authorityName);
    }
    expect(publicChannelFor('EA_CULTURAL_HERITAGE')?.name).toBe('Управление по охране культурного наследия');
    expect(publicChannelFor('EA_ECONOMY')?.name).toBe('Министерство экономического развития и промышленности');
  });
});
