import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ModuleEntry } from "./types";

// --- part_id → ステータス名マッピング ---
const STAT_NAMES: Record<number, string> = {
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

// --- part_id → アイコンファイル名マッピング ---
const STAT_ICONS: Record<number, string> = {
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

const ALL_STAT_NAMES = Object.values(STAT_NAMES);
const MODULE_TYPES = ["攻撃", "支援", "防御"] as const;

function utcToJst(utcStr: string): string {
  const d = new Date(utcStr + "Z");
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${mo}-${day} ${h}:${mi}`;
}

function statName(partId: number): string {
  return STAT_NAMES[partId] ?? `Unknown(${partId})`;
}

function statIcon(partId: number): string {
  const icon = STAT_ICONS[partId];
  return icon ? `<img class="sicon" src="/icons/${icon}" alt="">` : "";
}

// --- quality → レアリティ ---
type Rarity = "orange" | "gold" | "purple" | "blue";
const RARITY_LABEL: Record<Rarity, string> = {
  orange: "橙",
  gold: "金",
  purple: "紫",
  blue: "青",
};
const RARITY_ORDER: Record<Rarity, number> = { orange: 4, gold: 3, purple: 2, blue: 1 };

function qualityToRarity(q: number | null): Rarity {
  if (q === 5) return "gold"; // 橙は未実装、金として扱う
  if (q === 4) return "gold";
  if (q === 3) return "purple";
  return "blue";
}

// --- config_id → モジュールアイコン ---
const CONFIG_TYPE_MAP: Record<number, string> = { 1: "attack", 2: "device", 3: "protect" };
const CONFIG_RARITY_MAP: Record<number, number> = { 1: 2, 2: 3, 3: 4, 4: 5 };

function configIdToIcon(configId: number | null): { icon: string; bgRarity: number } | null {
  if (configId == null) return null;
  const lower = configId % 1000; // e.g. 5500202 → 202
  const typeDigit = Math.floor(lower / 100); // 2
  const rareSub = lower % 100; // 02
  const typeName = CONFIG_TYPE_MAP[typeDigit];
  const rarityNum = CONFIG_RARITY_MAP[rareSub];
  if (!typeName || !rarityNum) return null;
  // 背景: レア種別03と04は同じレアリティ(4)なのでrarity4.png
  const bgRarity = Math.min(rarityNum, 4);
  return {
    icon: `item_mod_${typeName}${rarityNum}.png`,
    bgRarity,
  };
}

function moduleIconHtml(configId: number | null): string {
  const info = configIdToIcon(configId);
  if (!info) return "";
  return `<div class="mod-icon-wrap">
    <img class="mod-icon-bg" src="/icons/rarity${info.bgRarity}.png" alt="">
    <img class="mod-icon-fg" src="/icons/${info.icon}" alt="">
  </div>`;
}

// --- Optimizer types ---
interface StatTotal {
  part_id: number;
  total: number;
  breakpoint: string;
  breakpoint_score: number;
  is_required: boolean;
  is_desired: boolean;
}
interface CombinationModule {
  uuid: number;
  quality: number | null;
  stats: { part_id: number; value: number }[];
}
interface Combination {
  rank: number;
  modules: CombinationModule[];
  stat_totals: StatTotal[];
  score: number;
  total_plus: number;
}
interface OptimizeResponse {
  combinations: Combination[];
  filtered_count: number;
  total_modules: number;
}

// --- State ---
let allModules: ModuleEntry[] = [];
let filterRarities: Rarity[] = [];
let filterStats: string[] = [];
let filterTypes: string[] = [];
let filterMode: 'and' | 'or' = 'and';
let sortKeys: { k: string; d: number }[] = [];

// Optimizer state
let optRequired: string[] = [];   // stat names
let optDesired: string[] = [];
let optExcluded: string[] = [];

// --- DOM ---
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function renderGrid() {
  let ms = [...allModules];

  // Apply filters: レアリティ・型は常にOR、ステータスはAND/ORモードに従う
  if (filterRarities.length > 0) {
    ms = ms.filter((m) => filterRarities.includes(qualityToRarity(m.quality)));
  }
  if (filterTypes.length > 0) {
    ms = ms.filter((m) => filterTypes.some((t) => configIdToType(m.config_id) === t));
  }
  if (filterStats.length > 0) {
    ms = filterMode === 'and'
      ? ms.filter((m) => filterStats.every((f) => m.stats.some((s) => statName(s.part_id) === f)))
      : ms.filter((m) => filterStats.some((f) => m.stats.some((s) => statName(s.part_id) === f)));
  }

  ms.sort((a, b) => {
    for (const s of sortKeys) {
      let va: string | number;
      let vb: string | number;
      if (s.k === "date") {
        va = a.acquired_date;
        vb = b.acquired_date;
      } else if (s.k === "rarity") {
        va = RARITY_ORDER[qualityToRarity(a.quality)];
        vb = RARITY_ORDER[qualityToRarity(b.quality)];
      } else if (s.k === "total") {
        va = a.stats.reduce((sum, x) => sum + x.value, 0);
        vb = b.stats.reduce((sum, x) => sum + x.value, 0);
      } else {
        va = a.stats.find((x) => statName(x.part_id) === s.k)?.value ?? 0;
        vb = b.stats.find((x) => statName(x.part_id) === s.k)?.value ?? 0;
      }
      if (va < vb) return s.d;
      if (va > vb) return -s.d;
    }
    return 0;
  });

  const g = $<HTMLDivElement>("grid");
  g.innerHTML = "";

  if (!ms.length) {
    g.innerHTML =
      '<div class="empty"><div style="font-size:24px;opacity:0.25">○</div><div style="font-size:13px">条件に一致するモジュールがありません</div></div>';
    $("sb-n").textContent = "0 モジュール";
    return;
  }

  ms.forEach((m, i) => {
    const c = document.createElement("div");
    c.className = "card";
    c.style.animationDelay = `${Math.min(i, 16) * 14}ms`;
    c.innerHTML = `
      <div class="card-head">
        ${moduleIconHtml(m.config_id)}
        <span class="cdate">${utcToJst(m.acquired_date)}</span>
      </div>
      <div class="divider"></div>
      <div class="stats">${m.stats
        .map(
          (s) => `
        <div class="srow">
          ${statIcon(s.part_id)}<span class="sname">${statName(s.part_id)}</span>
          <div class="sbar-w"><div class="sbar" style="width:${s.value * 10}%"></div></div>
          <span class="sval">+${s.value}</span>
        </div>`
        )
        .join("")}
      </div>`;
    g.appendChild(c);
  });

  $("sb-n").textContent = `${ms.length} モジュール`;
  const info: string[] = [];
  const filterCount = filterRarities.length + filterTypes.length + filterStats.length;
  if (filterCount) info.push(`絞込 ${filterCount}件(${filterMode.toUpperCase()})`);
  $("sb-i").textContent = info.join("　");
}

const RARITY_FILTERS: { label: string; value: Rarity }[] = [
  { label: "金", value: "gold" },
  { label: "紫", value: "purple" },
  { label: "青", value: "blue" },
];

function updateFilterBtnLabel() {
  const count = filterRarities.length + filterTypes.length + filterStats.length;
  const btn = $("filter-btn");
  btn.textContent = count > 0 ? `${count}件選択` : '未選択';
  btn.classList.toggle('has-items', count > 0);
}

function addFlySection(
  fl: HTMLElement,
  title: string,
  items: { label: string; checked: boolean }[],
  onChange: (index: number, checked: boolean) => void,
) {
  const header = document.createElement("div");
  header.className = "fly-section-header";
  header.textContent = title;
  fl.appendChild(header);

  items.forEach((item, i) => {
    const el = document.createElement("label");
    el.className = "fitem-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item.checked;
    cb.onchange = () => onChange(i, cb.checked);
    const span = document.createElement("span");
    span.textContent = item.label;
    el.appendChild(cb);
    el.appendChild(span);
    fl.appendChild(el);
  });
}

function openFilterMultiFly(anchor: HTMLElement) {
  const fl = $("fly-filter");
  if (fl.classList.contains("on")) {
    closeFly();
    return;
  }
  closeFly();
  fl.innerHTML = "";

  const refresh = () => { updateFilterBtnLabel(); renderGrid(); };

  // Section: レアリティ
  addFlySection(fl, "レアリティ",
    RARITY_FILTERS.map((r) => ({ label: r.label, checked: filterRarities.includes(r.value) })),
    (i, checked) => {
      const val = RARITY_FILTERS[i].value;
      if (checked) filterRarities.push(val);
      else { const idx = filterRarities.indexOf(val); if (idx >= 0) filterRarities.splice(idx, 1); }
      refresh();
    },
  );

  // Section: 型
  addFlySection(fl, "型",
    MODULE_TYPES.map((t) => ({ label: t, checked: filterTypes.includes(t) })),
    (i, checked) => {
      const val = MODULE_TYPES[i];
      if (checked) filterTypes.push(val);
      else { const idx = filterTypes.indexOf(val); if (idx >= 0) filterTypes.splice(idx, 1); }
      refresh();
    },
  );

  // Section: ステータス
  addFlySection(fl, "ステータス",
    ALL_STAT_NAMES.map((n) => ({ label: n, checked: filterStats.includes(n) })),
    (i, checked) => {
      const val = ALL_STAT_NAMES[i];
      if (checked) filterStats.push(val);
      else { const idx = filterStats.indexOf(val); if (idx >= 0) filterStats.splice(idx, 1); }
      refresh();
    },
  );

  const r = anchor.getBoundingClientRect();
  fl.style.left = r.left + "px";
  fl.style.top = r.bottom + 4 + "px";
  fl.classList.add("on");
  $("bd").classList.add("on");
}

function renderSChips() {
  const c = $("schips");
  c.innerHTML = "";
  sortKeys.forEach((s, _i) => {
    const lbl =
      s.k === "date" ? "入手" : s.k === "rarity" ? "レアリティ" : s.k === "total" ? "合計値" : s.k;
    const el = document.createElement("div");
    el.className = "schip on";
    el.innerHTML = `<span>${lbl}</span><span class="arr">${s.d === 1 ? "\u2193" : "\u2191"}</span><button class="schip-rm">\u00d7</button>`;
    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("schip-rm")) return;
      s.d *= -1;
      renderSChips();
      renderGrid();
    });
    const rm = el.querySelector<HTMLButtonElement>(".schip-rm");
    if (rm)
      rm.onclick = (e) => {
        e.stopPropagation();
        const idx = sortKeys.indexOf(s);
        if (idx >= 0) sortKeys.splice(idx, 1);
        renderSChips();
        renderGrid();
      };
    c.appendChild(el);
  });
}

// --- Flyout ---
function openFly(
  flyId: string,
  anchor: HTMLElement,
  items: { label: string; val: string; disabled: boolean }[],
  onPick: (item: { label: string; val: string }) => void
) {
  closeFly();
  const fl = $(flyId);
  fl.innerHTML = "";
  items.forEach((it) => {
    const el = document.createElement("div");
    el.className = "fitem" + (it.disabled ? " dim" : "");
    el.textContent = it.label;
    if (!it.disabled)
      el.onclick = () => {
        closeFly();
        onPick(it);
      };
    fl.appendChild(el);
  });
  const r = anchor.getBoundingClientRect();
  fl.style.left = r.left + "px";
  fl.style.top = r.bottom + 4 + "px";
  fl.classList.add("on");
  $("bd").classList.add("on");
}

function closeFly() {
  document.querySelectorAll(".flyout").forEach((f) => f.classList.remove("on"));
  $("bd").classList.remove("on");
}

// --- Optimizer state persistence ---

const OPT_STATE_KEY = "opt-last-state";
// パターンのキャッシュ（invoke の非同期を吸収するため）
let cachedPatterns: OptPattern[] = [];

interface OptPattern {
  name: string;
  required: string[];
  desired: string[];
  excluded: string[];
  quality: number;
}

function saveOptState() {
  const quality = Number(($<HTMLSelectElement>("opt-quality")).value);
  localStorage.setItem(OPT_STATE_KEY, JSON.stringify({
    required: optRequired,
    desired: optDesired,
    excluded: optExcluded,
    quality,
  }));
}

function restoreOptState() {
  const raw = localStorage.getItem(OPT_STATE_KEY);
  if (!raw) return;
  try {
    const s = JSON.parse(raw);
    if (Array.isArray(s.required)) optRequired = s.required.filter((n: string) => ALL_STAT_NAMES.includes(n));
    if (Array.isArray(s.desired)) optDesired = s.desired.filter((n: string) => ALL_STAT_NAMES.includes(n));
    if (Array.isArray(s.excluded)) optExcluded = s.excluded.filter((n: string) => ALL_STAT_NAMES.includes(n));
    if (s.quality) ($<HTMLSelectElement>("opt-quality")).value = String(s.quality);
  } catch { /* ignore */ }
}

function getPatterns(): OptPattern[] {
  return cachedPatterns;
}

async function loadPatternsFromBackend() {
  try {
    cachedPatterns = await invoke<OptPattern[]>("get_opt_patterns");
  } catch {
    cachedPatterns = [];
  }
}

async function savePatterns(patterns: OptPattern[]) {
  cachedPatterns = patterns;
  try {
    await invoke("save_opt_patterns", { patterns });
  } catch (e) {
    console.error("パターン保存エラー:", e);
  }
}

function renderPatternSelect() {
  const sel = $<HTMLSelectElement>("pattern-select");
  const patterns = getPatterns();
  sel.innerHTML = '<option value="">-- 選択 --</option>';
  patterns.forEach((p, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
}

function loadPattern(idx: number) {
  const patterns = getPatterns();
  const p = patterns[idx];
  if (!p) return;
  optRequired = p.required.filter((n) => ALL_STAT_NAMES.includes(n));
  optDesired = p.desired.filter((n) => ALL_STAT_NAMES.includes(n));
  optExcluded = p.excluded.filter((n) => ALL_STAT_NAMES.includes(n));
  if (p.quality) ($<HTMLSelectElement>("opt-quality")).value = String(p.quality);
  updateOptBtnLabel('req');
  updateOptBtnLabel('des');
  updateOptBtnLabel('excl');
  updateOptRunBtn();
  saveOptState();
}

// --- Optimizer UI ---

const STAT_NAME_TO_ID: Record<string, number> = Object.fromEntries(
  Object.entries(STAT_NAMES).map(([id, name]) => [name, Number(id)])
);

function updateOptBtnLabel(category: 'req' | 'des' | 'excl') {
  const btnId = { req: 'opt-btn-req', des: 'opt-btn-des', excl: 'opt-btn-excl' }[category];
  const items = { req: optRequired, des: optDesired, excl: optExcluded }[category];
  const btn = $(btnId);
  btn.textContent = items.length > 0 ? `${items.length}件選択` : '未選択';
  btn.classList.toggle('has-items', items.length > 0);
}

function openOptMultiFly(anchor: HTMLElement, category: 'req' | 'des' | 'excl') {
  const fl = $("fly-multi");
  if (fl.classList.contains("on") && fl.dataset.category === category) {
    closeFly();
    return;
  }
  closeFly();
  fl.dataset.category = category;
  const current = { req: optRequired, des: optDesired, excl: optExcluded }[category];
  const others = (['req', 'des', 'excl'] as const)
    .filter((k) => k !== category)
    .flatMap((k) => ({ req: optRequired, des: optDesired, excl: optExcluded }[k]));
  const otherSet = new Set(others);

  fl.innerHTML = "";
  ALL_STAT_NAMES.forEach((name) => {
    const isSelected = current.includes(name);
    const isOther = otherSet.has(name);
    const el = document.createElement("label");
    el.className = "fitem-check" + (isOther ? " dim" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = isSelected;
    cb.disabled = isOther;
    if (!isOther) {
      cb.onchange = () => {
        if (cb.checked) {
          current.push(name);
        } else {
          const idx = current.indexOf(name);
          if (idx >= 0) current.splice(idx, 1);
        }
        updateOptBtnLabel(category);
        updateOptRunBtn();
        saveOptState();
      };
    }
    const span = document.createElement("span");
    span.textContent = name;
    el.appendChild(cb);
    el.appendChild(span);
    fl.appendChild(el);
  });

  const r = anchor.getBoundingClientRect();
  fl.style.left = r.left + "px";
  fl.style.top = r.bottom + 4 + "px";
  fl.classList.add("on");
  $("bd").classList.add("on");
}

function updateOptRunBtn() {
  ($<HTMLButtonElement>("opt-run")).disabled = optRequired.length === 0;
}

async function runOptimize() {
  const btn = $<HTMLButtonElement>("opt-run");
  btn.classList.add("loading");
  btn.textContent = "計算中...";

  const scrollArea = $("opt-scroll");
  $("opt-empty").style.display = "none";
  $("opt-results").style.display = "none";
  const overlay = document.createElement("div");
  overlay.className = "opt-loading-overlay";
  overlay.innerHTML = `<div class="loader"><ul class="hexagon-container">
    <li class="hexagon hex_1"></li><li class="hexagon hex_2"></li>
    <li class="hexagon hex_3"></li><li class="hexagon hex_4"></li>
    <li class="hexagon hex_5"></li><li class="hexagon hex_6"></li>
    <li class="hexagon hex_7"></li></ul></div>`;
  scrollArea.appendChild(overlay);

  const quality = Number(($<HTMLSelectElement>("opt-quality")).value);
  const req = {
    required_stats: optRequired.map((n) => STAT_NAME_TO_ID[n]).filter(Boolean),
    desired_stats: optDesired.map((n) => STAT_NAME_TO_ID[n]).filter(Boolean),
    excluded_stats: optExcluded.map((n) => STAT_NAME_TO_ID[n]).filter(Boolean),
    min_quality: quality,
  };

  try {
    const res = await invoke<OptimizeResponse>("optimize_modules", { req });
    renderOptResults(res);
  } catch (e) {
    console.error("optimize error:", e);
    $("opt-results").style.display = "none";
    $("opt-empty").style.display = "flex";
    ($("opt-empty")).innerHTML =
      '<div style="font-size:28px;opacity:0.22">!</div><div>最適化中にエラーが発生しました</div>';
  } finally {
    overlay.remove();
    btn.classList.remove("loading");
    btn.textContent = "最適化実行";
  }
}

function renderOptResults(res: OptimizeResponse) {
  const empty = $("opt-empty");
  const results = $("opt-results");

  if (res.combinations.length === 0) {
    results.style.display = "none";
    empty.style.display = "flex";
    empty.innerHTML =
      '<div style="font-size:28px;opacity:0.22">○</div><div>条件に合う組み合わせが見つかりませんでした</div>';
    return;
  }

  empty.style.display = "none";
  results.style.display = "flex";
  results.innerHTML = "";

  // Info line
  const info = document.createElement("div");
  info.className = "opt-info";
  info.textContent = `${res.total_modules}件中 ${res.filtered_count}件のモジュールから探索 — 上位${res.combinations.length}件`;
  results.appendChild(info);

  res.combinations.forEach((comb) => {
    const card = document.createElement("div");
    card.className = "opt-card";
    card.style.animationDelay = `${(comb.rank - 1) * 30}ms`;

    const rankClass =
      comb.rank === 1 ? "r1" : comb.rank === 2 ? "r2" : comb.rank === 3 ? "r3" : "";

    const statTags = comb.stat_totals
      .map((st) => {
        const cls = st.is_required ? "req" : st.is_desired ? "des" : "other";
        return `<span class="opt-stat-tag ${cls}">${statIcon(st.part_id)}<span>${statName(st.part_id)}</span> <span class="bp">+${st.total}</span></span>`;
      })
      .join("");

    card.innerHTML = `
      <div class="opt-rank ${rankClass}">#${comb.rank}</div>
      <div class="opt-card-body">
        <div class="opt-card-stats">${statTags}</div>
      </div>
      <div class="opt-card-plus">合計: ${comb.total_plus}</div>`;

    card.onclick = () => openModal(comb);
    results.appendChild(card);
  });
}

// --- Modal ---

function openModal(comb: Combination) {
  const bd = $("modal-bd");
  const body = $("modal-body");
  $("modal-title").textContent = `#${comb.rank} 組み合わせ詳細`;

  // モジュール一覧
  const modsHtml = comb.modules
    .map((m) => {
      const statsHtml = m.stats
        .map(
          (s) => `
          <div class="srow">
            ${statIcon(s.part_id)}<span class="sname">${statName(s.part_id)}</span>
            <div class="sbar-w"><div class="sbar" style="width:${s.value * 10}%"></div></div>
            <span class="sval">+${s.value}</span>
          </div>`
        )
        .join("");
      const origMod = allModules.find((om) => om.uuid === m.uuid);
      return `
        <div class="modal-mod">
          <div class="modal-mod-head">
            ${moduleIconHtml(origMod?.config_id ?? null)}
          </div>
          <div class="stats">${statsHtml}</div>
        </div>`;
    })
    .join("");

  // ステータス合計テーブル
  const statTotalsMap = new Map<number, number>();
  comb.modules.forEach((m) => {
    m.stats.forEach((s) => {
      statTotalsMap.set(s.part_id, (statTotalsMap.get(s.part_id) ?? 0) + s.value);
    });
  });
  const reqIds = new Set(comb.stat_totals.filter((st) => st.is_required).map((st) => st.part_id));
  const desIds = new Set(comb.stat_totals.filter((st) => st.is_desired).map((st) => st.part_id));

  const rowsHtml = Array.from(statTotalsMap.entries())
    .sort((a, b) => {
      const aP = reqIds.has(a[0]) ? 0 : desIds.has(a[0]) ? 1 : 2;
      const bP = reqIds.has(b[0]) ? 0 : desIds.has(b[0]) ? 1 : 2;
      return aP !== bP ? aP - bP : b[1] - a[1];
    })
    .map(([pid, total]) => {
      const typeTag = reqIds.has(pid)
        ? `<span class="type-req">メイン</span>`
        : desIds.has(pid)
          ? `<span class="type-des">サブ</span>`
          : "";
      return `
      <tr>
        <td>${statIcon(pid)} ${statName(pid)}</td>
        <td class="val">+${total}</td>
        <td>${typeTag}</td>
      </tr>`;
    })
    .join("");

  body.innerHTML = `
    <div class="modal-section">
      <div class="modal-section-title">使用モジュール</div>
      <div class="modal-modules">${modsHtml}</div>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">ステータス合計 <span style="font-weight:400;font-size:11px;color:var(--tx2);text-transform:none;letter-spacing:0">合計 ${comb.total_plus}</span></div>
      <table class="modal-table">
        <thead><tr><th>ステータス</th><th>合計値</th><th>分類</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;

  bd.classList.add("on");
}

function closeModal() {
  $("modal-bd").classList.remove("on");
}

// --- Export ---
function generateExportJson(): string {
  const data = allModules.map((m) => ({
    uuid: m.uuid,
    config_id: m.config_id,
    quality: m.quality,
    rarity: RARITY_LABEL[qualityToRarity(m.quality)],
    stats: m.stats.map((s) => ({
      name: statName(s.part_id),
      part_id: s.part_id,
      value: s.value,
    })),
    total_value: m.stats.reduce((sum, s) => sum + s.value, 0),
    success_rate: m.success_rate,
    equipped_slot: m.equipped_slot,
    acquired_date: utcToJst(m.acquired_date),
  }));
  return JSON.stringify(data, null, 2);
}

function configIdToType(configId: number | null): string {
  if (configId == null) return "";
  const prefix = Math.floor(configId / 100);
  if (prefix === 55001) return "攻撃";
  if (prefix === 55002) return "支援";
  if (prefix === 55003) return "防御";
  return "";
}

function generateExportCsv(): string {
  const BOM = "\uFEFF";
  const maxStats = allModules.reduce((mx, m) => Math.max(mx, m.stats.length), 0);
  const statCols = Math.max(maxStats, 3);

  const headers: string[] = ["ID", "型", "レアリティ"];
  for (let i = 1; i <= statCols; i++) {
    headers.push(`status_${i}`, `value_${i}`);
  }
  headers.push("合計値", "入手日時");

  const rows: string[] = [headers.join(",")];

  for (const m of allModules) {
    const cols: (string | number)[] = [
      m.uuid,
      configIdToType(m.config_id),
      RARITY_LABEL[qualityToRarity(m.quality)],
    ];
    for (let i = 0; i < statCols; i++) {
      if (i < m.stats.length) {
        cols.push(statName(m.stats[i].part_id), m.stats[i].value);
      } else {
        cols.push("", "");
      }
    }
    cols.push(
      m.stats.reduce((sum, s) => sum + s.value, 0),
      utcToJst(m.acquired_date)
    );
    rows.push(cols.join(","));
  }

  return BOM + rows.join("\n");
}

// --- Load modules from backend ---
async function loadModules() {
  try {
    allModules = await invoke<ModuleEntry[]>("get_modules");
  } catch {
    allModules = [];
  }
  renderGrid();
}

// --- Init ---
async function init() {
  // Window controls
  const appWindow = getCurrentWindow();
  $("win-minimize").onclick = () => appWindow.minimize();
  $("win-close").onclick = () => appWindow.close();

  // Pin toggle (always on top)
  const pinToggle = $("pin-toggle");
  pinToggle.onclick = async () => {
    const next = !pinToggle.classList.contains("active");
    await appWindow.setAlwaysOnTop(next);
    pinToggle.classList.toggle("active", next);
  };

  // Export button
  $("export-btn").onclick = (e) => {
    openFly(
      "fly-f",
      e.currentTarget as HTMLElement,
      [
        { label: "JSON出力", val: "json", disabled: false },
        { label: "CSV出力", val: "csv", disabled: false },
      ],
      async (it) => {
        const content =
          it.val === "json" ? generateExportJson() : generateExportCsv();
        try {
          await invoke("export_to_file", { format: it.val, content });
        } catch (err) {
          console.error("export error:", err);
        }
      }
    );
  };

  // Tabs
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      $("panel-" + t.dataset.tab!).classList.add("active");
    };
  });

  // Filter dropdown
  $("filter-btn").onclick = (e) => {
    openFilterMultiFly(e.currentTarget as HTMLElement);
  };

  // AND/OR toggle
  const modeBtn = $("filter-mode");
  modeBtn.onclick = () => {
    filterMode = filterMode === 'and' ? 'or' : 'and';
    modeBtn.textContent = filterMode.toUpperCase();
    modeBtn.classList.toggle('or', filterMode === 'or');
    renderGrid();
  };

  // Sort add
  $("add-s").onclick = (e) => {
    const ex = new Set(sortKeys.map((s) => s.k));
    const extraItems: { label: string; val: string; disabled: boolean }[] = [
      { label: "入手", val: "date", disabled: ex.has("date") },
      { label: "レアリティ", val: "rarity", disabled: ex.has("rarity") },
      { label: "合計値", val: "total", disabled: ex.has("total") },
    ];
    const statItems = ALL_STAT_NAMES.map((s) => ({ label: s, val: s, disabled: ex.has(s) }));
    openFly(
      "fly-s",
      e.currentTarget as HTMLElement,
      [...extraItems, ...statItems],
      (it) => {
        sortKeys.push({ k: it.val, d: 1 });
        renderSChips();
        renderGrid();
      }
    );
  };

  // Backdrop
  $("bd").onclick = closeFly;

  // --- Optimizer panel ---

  // メインステ選択
  $("opt-btn-req").onclick = (e) => {
    openOptMultiFly(e.currentTarget as HTMLElement, 'req');
  };

  // サブステ選択
  $("opt-btn-des").onclick = (e) => {
    openOptMultiFly(e.currentTarget as HTMLElement, 'des');
  };

  // 対象外ステ選択
  $("opt-btn-excl").onclick = (e) => {
    openOptMultiFly(e.currentTarget as HTMLElement, 'excl');
  };

  // レアリティselect変更時も保存
  $("opt-quality").onchange = () => saveOptState();

  // 実行ボタン
  $("opt-run").onclick = () => runOptimize();

  // --- パターン管理 ---
  await loadPatternsFromBackend();
  renderPatternSelect();

  $("pattern-load").onclick = () => {
    const idx = Number(($<HTMLSelectElement>("pattern-select")).value);
    if (!isNaN(idx) && idx >= 0) loadPattern(idx);
  };

  $("pattern-save").onclick = async () => {
    const name = prompt("パターン名を入力してください");
    if (!name || !name.trim()) return;
    const quality = Number(($<HTMLSelectElement>("opt-quality")).value);
    const patterns = getPatterns();
    const existing = patterns.findIndex((p) => p.name === name.trim());
    const entry: OptPattern = {
      name: name.trim(),
      required: [...optRequired],
      desired: [...optDesired],
      excluded: [...optExcluded],
      quality,
    };
    if (existing >= 0) {
      patterns[existing] = entry;
    } else {
      patterns.push(entry);
    }
    await savePatterns(patterns);
    renderPatternSelect();
    ($<HTMLSelectElement>("pattern-select")).value = String(existing >= 0 ? existing : patterns.length - 1);
  };

  $("pattern-delete").onclick = async () => {
    const sel = $<HTMLSelectElement>("pattern-select");
    const idx = Number(sel.value);
    if (isNaN(idx) || idx < 0) return;
    const patterns = getPatterns();
    const p = patterns[idx];
    if (!p) return;
    if (!confirm(`パターン「${p.name}」を削除しますか？`)) return;
    patterns.splice(idx, 1);
    await savePatterns(patterns);
    renderPatternSelect();
  };

  // モーダル閉じ
  $("modal-close").onclick = closeModal;
  $("modal-bd").onclick = (e) => {
    if (e.target === $("modal-bd")) closeModal();
  };

  // 前回の状態を復元
  restoreOptState();
  updateOptBtnLabel('req');
  updateOptBtnLabel('des');
  updateOptBtnLabel('excl');
  updateOptRunBtn();

  // バックエンドからのイベントを監視
  await listen("modules-updated", () => {
    loadModules();
  });

  await listen("server-found", () => {
    $("sb-monitor").textContent = "サーバー接続済み";
  });

  // キャプチャトグル
  const capToggle = $("cap-toggle") as HTMLButtonElement;
  capToggle.addEventListener("click", async () => {
    const isActive = capToggle.classList.contains("active");
    if (isActive) {
      await invoke("stop_capture_cmd");
      capToggle.classList.remove("active");
      $("sb-monitor").textContent = "";
    } else {
      await invoke("start_capture_cmd");
      capToggle.classList.add("active");
      $("sb-monitor").textContent = "サーバー検出中...";
    }
  });

  updateFilterBtnLabel();
  renderSChips();
  loadModules();
}

document.addEventListener("DOMContentLoaded", init);
