/** part_id → ステータス名 */
export const STAT_NAMES: Record<number, string> = {
  1110: "筋力強化",
  1111: "敏捷強化",
  1112: "知力強化",
  1113: "特攻ダメージ強化",
  1114: "精鋭打撃",
  1205: "特攻回復強化",
  1206: "マスタリー回復強化",
  1307: "魔法耐性",
  1308: "物理耐性",
  1407: "集中・詠唱",
  1408: "集中・攻撃速度",
  1409: "集中・会心",
  1410: "集中・幸運",
  2104: "極・ダメージ増加",
  2105: "極・適応力",
  2204: "極・HP凝縮",
  2205: "極・応急処置",
  2304: "極・絶境守護",
  2404: "極・HP変動",
  2405: "極・HP吸収",
  2406: "極・幸運会心",
};

/** part_id → アイコンファイル名 */
export const STAT_ICONS: Record<number, string> = {
  1110: "mod_effect_icon_011.png",
  1111: "mod_effect_icon_039.png",
  1112: "mod_effect_icon_034.png",
  1113: "mod_effect_icon_002.png",
  1114: "mod_effect_icon_038.png",
  1205: "mod_effect_icon_023.png",
  1206: "mod_effect_icon_042.png",
  1307: "mod_effect_icon_009.png",
  1308: "mod_effect_icon_014.png",
  1407: "mod_effect_icon_013.png",
  1408: "mod_effect_icon_026.png",
  1409: "mod_effect_icon_019.png",
  1410: "mod_effect_icon_048.png",
  2104: "mod_effect_icon_016.png",
  2105: "mod_effect_icon_006.png",
  2204: "mod_effect_icon_012.png",
  2205: "mod_effect_icon_024.png",
  2304: "mod_effect_icon_045.png",
  2404: "mod_effect_icon_004.png",
  2405: "mod_effect_icon_035.png",
  2406: "mod_effect_icon_017.png",
};

export const ALL_STAT_IDS = Object.keys(STAT_NAMES).map(Number);
export const ALL_STAT_NAMES = Object.values(STAT_NAMES);

export function statName(partId: number): string {
  return STAT_NAMES[partId] ?? `Unknown(${partId})`;
}

export function statIdByName(name: string): number | undefined {
  return ALL_STAT_IDS.find((id) => STAT_NAMES[id] === name);
}

/** モジュール型 */
export const MODULE_TYPES = ["攻撃", "支援", "防御"] as const;
export type ModuleType = (typeof MODULE_TYPES)[number];

/** config_id → 型名 */
const CONFIG_TYPE_PREFIX: Record<number, ModuleType> = {
  55001: "攻撃",
  55002: "支援",
  55003: "防御",
};

/** config_id 下3桁 → 型コード(英名) / レアリティ */
const CONFIG_TYPE_MAP: Record<number, string> = { 1: "attack", 2: "device", 3: "protect" };
const CONFIG_RARITY_MAP: Record<number, number> = { 1: 2, 2: 3, 3: 4, 4: 5 };

export function configIdToType(configId: number | null): ModuleType | null {
  if (configId == null) return null;
  const prefix = Math.floor(configId / 100);
  return CONFIG_TYPE_PREFIX[prefix] ?? null;
}

export function configIdToIcon(configId: number | null): { icon: string; bgRarity: number } | null {
  if (configId == null) return null;
  const lower = configId % 1000;
  const typeDigit = Math.floor(lower / 100);
  const rareSub = lower % 100;
  const typeName = CONFIG_TYPE_MAP[typeDigit];
  const rarityNum = CONFIG_RARITY_MAP[rareSub];
  if (!typeName || !rarityNum) return null;
  const bgRarity = Math.min(rarityNum, 4);
  return {
    icon: `item_mod_${typeName}${rarityNum}.png`,
    bgRarity,
  };
}

/** モジュールアイコン: 型(英名) × レアリティ → ファイル名 */
export const MODULE_ICONS: { type: string; rarity: number; file: string }[] = [];
for (const [typeDigit, typeName] of Object.entries(CONFIG_TYPE_MAP)) {
  for (const [rareSub, rarityNum] of Object.entries(CONFIG_RARITY_MAP)) {
    MODULE_ICONS.push({
      type: typeName,
      rarity: rarityNum,
      file: `item_mod_${typeName}${rarityNum}.png`,
    });
  }
}
