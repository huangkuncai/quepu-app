/** 宿松麻将规则配置（第一版占位，具体牌型/番型以产品规则确认后补全）。 */
export const susongRule = {
  id: 'susong_v1', name: '宿松麻将', players: 4, scoreSettlement: 'points',
  tiles: { suits: ['wan', 'tiao', 'tong'], ranks: [1,2,3,4,5,6,7,8,9], honors: [] },
  actions: ['draw', 'discard', 'chi', 'peng', 'gang', 'hu', 'pass'],
  scoring: { base: 1, cap: null, selfDrawBonus: 1 }
};

export const ruleRegistry = new Map([[susongRule.id, susongRule]]);
