import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ModuleEntry } from "./types";
import { JA, KO, EN, JA_STAT_NAME_TO_ID, setLang, mergeLang, fmt, t } from "./i18n";

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

/** HTML特殊文字をエスケープ（カスタム言語データを innerHTML に挿入する際に使用） */
function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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
  return t.stat_names[String(partId)] ?? `Unknown(${partId})`;
}

function statIcon(partId: number): string {
  const icon = STAT_ICONS[partId];
  return icon ? `<img class="sicon" src="/icons/${icon}" alt="">` : "";
}

// --- quality → レアリティ ---
type Rarity = "orange" | "gold" | "purple" | "blue";
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

function moduleIconHtml(configId: number | null): string {
  const info = configIdToIcon(configId);
  if (!info) return "";
  return `<div class="mod-icon-wrap">
    <img class="mod-icon-bg" src="/icons/rarity${info.bgRarity}.png" alt="">
    <img class="mod-icon-fg" src="/icons/${info.icon}" alt="">
  </div>`;
}

/** config_id → モジュール型名（表示用） */
function configIdToType(configId: number | null): string {
  if (configId == null) return "";
  const prefix = Math.floor(configId / 100);
  return t.module_types[String(prefix)] ?? "";
}

/** config_id → モジュール型キー ("55001" | "55002" | "55003") */
function configIdToTypeKey(configId: number | null): string {
  if (configId == null) return "";
  return String(Math.floor(configId / 100));
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
let filterStats: number[] = [];      // part_id
let filterTypes: string[] = [];      // config prefix key: "55001" | "55002" | "55003"
let filterMode: "and" | "or" = "and";
let sortKeys: { k: string; d: number }[] = [];

// Optimizer state (part_ids)
let optRequired: number[] = [];
let optDesired: number[] = [];
let optExcluded: number[] = [];

// --- DOM ---
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** data-i18n / data-i18n-aria 属性を持つ要素にテキストを適用 */
function applyI18n(): void {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n!;
    el.textContent = t.ui[key] ?? el.textContent;
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((el) => {
    const key = el.dataset.i18nAria!;
    el.setAttribute("aria-label", t.ui[key] ?? "");
  });
  // select options
  const qualSel = $<HTMLSelectElement>("opt-quality");
  qualSel.options[0].text = t.ui.rarity_purple_up;
  qualSel.options[1].text = t.ui.rarity_gold_only;
  // pattern select placeholder
  const patSel = $<HTMLSelectElement>("pattern-select");
  if (patSel.options.length > 0) patSel.options[0].text = t.ui.pattern_placeholder;
  // theme/lang select options
  const themeSel = $<HTMLSelectElement>("menu-theme-select");
  themeSel.options[0].text = t.ui.theme_system;
  themeSel.options[1].text = t.ui.theme_light;
  themeSel.options[2].text = t.ui.theme_dark;
  const langSel = $<HTMLSelectElement>("menu-lang-select");
  langSel.options[0].text = t.ui.lang_ja;
  langSel.options[1].text = t.ui.lang_ko;
  langSel.options[2].text = t.ui.lang_en;
  langSel.options[3].text = t.ui.lang_custom;
  // opt-empty 初期テキスト
  $("opt-empty-text").textContent = t.ui.opt_empty;
  // ステータスバー初期値
  $("sb-n").textContent = fmt(t.ui.n_modules, { count: 0 });
}

function renderGrid() {
  let ms = [...allModules];

  if (filterRarities.length > 0) {
    ms = ms.filter((m) => filterRarities.includes(qualityToRarity(m.quality)));
  }
  if (filterTypes.length > 0) {
    ms = ms.filter((m) => filterTypes.some((k) => configIdToTypeKey(m.config_id) === k));
  }
  if (filterStats.length > 0) {
    ms = filterMode === "and"
      ? ms.filter((m) => filterStats.every((pid) => m.stats.some((s) => s.part_id === pid)))
      : ms.filter((m) => filterStats.some((pid) => m.stats.some((s) => s.part_id === pid)));
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
        const pid = Number(s.k);
        va = a.stats.find((x) => x.part_id === pid)?.value ?? 0;
        vb = b.stats.find((x) => x.part_id === pid)?.value ?? 0;
      }
      if (va < vb) return s.d;
      if (va > vb) return -s.d;
    }
    return 0;
  });

  const g = $<HTMLDivElement>("grid");
  g.innerHTML = "";

  if (!ms.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const icon = document.createElement("div");
    icon.style.cssText = "font-size:24px;opacity:0.25";
    icon.textContent = "○";
    const msg = document.createElement("div");
    msg.style.fontSize = "13px";
    msg.textContent = t.ui.no_modules_msg;
    empty.appendChild(icon);
    empty.appendChild(msg);
    g.appendChild(empty);
    $("sb-n").textContent = fmt(t.ui.n_modules, { count: 0 });
    return;
  }

  ms.forEach((m, i) => {
    const c = document.createElement("div");
    c.className = "card";
    c.style.animationDelay = `${Math.min(i, 16) * 14}ms`;
    const statsHtml = m.stats
      .map(
        (s) => `
        <div class="srow">
          ${statIcon(s.part_id)}<span class="sname">${esc(statName(s.part_id))}</span>
          <div class="sbar-w"><div class="sbar" style="width:${s.value * 10}%"></div></div>
          <span class="sval">+${s.value}</span>
        </div>`
      )
      .join("");
    c.innerHTML = `
      <div class="card-head">
        ${moduleIconHtml(m.config_id)}
        <span class="cdate">${esc(utcToJst(m.acquired_date))}</span>
      </div>
      <div class="divider"></div>
      <div class="stats">${statsHtml}</div>`;
    g.appendChild(c);
  });

  $("sb-n").textContent = fmt(t.ui.n_modules, { count: ms.length });
  const info: string[] = [];
  const filterCount = filterRarities.length + filterTypes.length + filterStats.length;
  if (filterCount) info.push(fmt(t.ui.filter_info, { count: filterCount }) + `(${filterMode.toUpperCase()})`);
  $("sb-i").textContent = info.join("　");
}

const RARITY_FILTER_KEYS: Rarity[] = ["gold", "purple", "blue"];

function updateFilterBtnLabel() {
  const count = filterRarities.length + filterTypes.length + filterStats.length;
  const btn = $("filter-btn");
  btn.textContent = count > 0 ? fmt(t.ui.filter_count, { count }) : t.ui.filter_none;
  btn.classList.toggle("has-items", count > 0);
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
  addFlySection(fl, t.ui.fly_rarity,
    RARITY_FILTER_KEYS.map((r) => ({ label: t.rarity[r], checked: filterRarities.includes(r) })),
    (i, checked) => {
      const val = RARITY_FILTER_KEYS[i];
      if (checked) filterRarities.push(val);
      else { const idx = filterRarities.indexOf(val); if (idx >= 0) filterRarities.splice(idx, 1); }
      refresh();
    },
  );

  // Section: 型
  const moduleTypeEntries = Object.entries(t.module_types);
  addFlySection(fl, t.ui.fly_type,
    moduleTypeEntries.map(([key]) => ({ label: t.module_types[key], checked: filterTypes.includes(key) })),
    (i, checked) => {
      const key = moduleTypeEntries[i][0];
      if (checked) filterTypes.push(key);
      else { const idx = filterTypes.indexOf(key); if (idx >= 0) filterTypes.splice(idx, 1); }
      refresh();
    },
  );

  // Section: ステータス
  const allStatIds = Object.keys(t.stat_names).map(Number);
  addFlySection(fl, t.ui.fly_stat,
    allStatIds.map((pid) => ({ label: statName(pid), checked: filterStats.includes(pid) })),
    (i, checked) => {
      const pid = allStatIds[i];
      if (checked) filterStats.push(pid);
      else { const idx = filterStats.indexOf(pid); if (idx >= 0) filterStats.splice(idx, 1); }
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
  sortKeys.forEach((s) => {
    const lbl =
      s.k === "date" ? t.ui.sort_date :
      s.k === "rarity" ? t.ui.sort_rarity :
      s.k === "total" ? t.ui.sort_total :
      statName(Number(s.k));
    const el = document.createElement("div");
    el.className = "schip on";
    const labelSpan = document.createElement("span");
    labelSpan.textContent = lbl;
    const arrSpan = document.createElement("span");
    arrSpan.className = "arr";
    arrSpan.textContent = s.d === 1 ? "\u2193" : "\u2191";
    const rmBtn = document.createElement("button");
    rmBtn.className = "schip-rm";
    rmBtn.textContent = "\u00d7";
    el.appendChild(labelSpan);
    el.appendChild(arrSpan);
    el.appendChild(rmBtn);
    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("schip-rm")) return;
      s.d *= -1;
      arrSpan.textContent = s.d === 1 ? "\u2193" : "\u2191";
      renderGrid();
    });
    rmBtn.onclick = (e) => {
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
let cachedPatterns: OptPattern[] = [];

/** part_id リストに変換（旧フォーマット: 日本語名文字列を自動マイグレーション） */
function toPartIds(items: (string | number)[]): number[] {
  const validIds = new Set(Object.keys(t.stat_names).map(Number));
  return items
    .map((n): number | null => {
      if (typeof n === "string") return JA_STAT_NAME_TO_ID[n] ?? null;
      return n;
    })
    .filter((id): id is number => id != null && validIds.has(id));
}

interface OptPattern {
  name: string;
  required: (string | number)[];
  desired: (string | number)[];
  excluded: (string | number)[];
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
    if (Array.isArray(s.required)) optRequired = toPartIds(s.required);
    if (Array.isArray(s.desired)) optDesired = toPartIds(s.desired);
    if (Array.isArray(s.excluded)) optExcluded = toPartIds(s.excluded);
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
  sel.innerHTML = "";
  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = t.ui.pattern_placeholder;
  sel.appendChild(defaultOpt);
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
  optRequired = toPartIds(p.required);
  optDesired = toPartIds(p.desired);
  optExcluded = toPartIds(p.excluded);
  if (p.quality) ($<HTMLSelectElement>("opt-quality")).value = String(p.quality);
  updateOptBtnLabel("req");
  updateOptBtnLabel("des");
  updateOptBtnLabel("excl");
  updateOptRunBtn();
  saveOptState();
}

// --- Optimizer UI ---

function updateOptBtnLabel(category: "req" | "des" | "excl") {
  const btnId = { req: "opt-btn-req", des: "opt-btn-des", excl: "opt-btn-excl" }[category];
  const items = { req: optRequired, des: optDesired, excl: optExcluded }[category];
  const btn = $(btnId);
  btn.textContent = items.length > 0 ? fmt(t.ui.filter_count, { count: items.length }) : t.ui.filter_none;
  btn.classList.toggle("has-items", items.length > 0);
}

function openOptMultiFly(anchor: HTMLElement, category: "req" | "des" | "excl") {
  const fl = $("fly-multi");
  if (fl.classList.contains("on") && fl.dataset.category === category) {
    closeFly();
    return;
  }
  closeFly();
  fl.dataset.category = category;
  const current = { req: optRequired, des: optDesired, excl: optExcluded }[category];
  const others = (["req", "des", "excl"] as const)
    .filter((k) => k !== category)
    .flatMap((k) => ({ req: optRequired, des: optDesired, excl: optExcluded }[k]));
  const otherSet = new Set(others);

  fl.innerHTML = "";
  const allStatIds = Object.keys(t.stat_names).map(Number);
  allStatIds.forEach((pid) => {
    const isSelected = current.includes(pid);
    const isOther = otherSet.has(pid);
    const el = document.createElement("label");
    el.className = "fitem-check" + (isOther ? " dim" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = isSelected;
    cb.disabled = isOther;
    if (!isOther) {
      cb.onchange = () => {
        if (cb.checked) {
          current.push(pid);
        } else {
          const idx = current.indexOf(pid);
          if (idx >= 0) current.splice(idx, 1);
        }
        updateOptBtnLabel(category);
        updateOptRunBtn();
        saveOptState();
      };
    }
    const span = document.createElement("span");
    span.textContent = statName(pid);
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
  btn.textContent = t.ui.btn_running;

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
  const speedMode = ($<HTMLSelectElement>("opt-speed")).value;
  const req = {
    required_stats: optRequired,
    desired_stats: optDesired,
    excluded_stats: optExcluded,
    min_quality: quality,
    speed_mode: speedMode,
  };

  try {
    const res = await invoke<OptimizeResponse>("optimize_modules", { req });
    renderOptResults(res);
  } catch (e) {
    console.error("optimize error:", e);
    $("opt-results").style.display = "none";
    const empty = $("opt-empty");
    empty.style.display = "flex";
    empty.textContent = "";
    const icon = document.createElement("div");
    icon.style.cssText = "font-size:28px;opacity:0.22";
    icon.textContent = "!";
    const msg = document.createElement("div");
    msg.textContent = t.ui.error_optimize;
    empty.appendChild(icon);
    empty.appendChild(msg);
  } finally {
    overlay.remove();
    btn.classList.remove("loading");
    btn.textContent = t.ui.btn_run;
  }
}

function renderOptResults(res: OptimizeResponse) {
  const empty = $("opt-empty");
  const results = $("opt-results");

  if (res.combinations.length === 0) {
    results.style.display = "none";
    empty.style.display = "flex";
    empty.textContent = "";
    const icon = document.createElement("div");
    icon.style.cssText = "font-size:28px;opacity:0.22";
    icon.textContent = "○";
    const msg = document.createElement("div");
    msg.textContent = t.ui.no_result;
    empty.appendChild(icon);
    empty.appendChild(msg);
    return;
  }

  empty.style.display = "none";
  results.style.display = "flex";
  results.innerHTML = "";

  const info = document.createElement("div");
  info.className = "opt-info";
  info.textContent = fmt(t.ui.result_info, {
    total: res.total_modules,
    filtered: res.filtered_count,
    count: res.combinations.length,
  });
  results.appendChild(info);


  res.combinations.forEach((comb) => {
    const card = document.createElement("div");
    card.className = "opt-card";
    card.style.animationDelay = `${(comb.rank - 1) * 30}ms`;

    const rankClass =
      comb.rank === 1 ? "r1" : comb.rank === 2 ? "r2" : comb.rank === 3 ? "r3" : "";

    const statTags = comb.stat_totals
      .slice()
      .sort((a, b) => {
        const aP = a.is_required ? 0 : a.is_desired ? 1 : 2;
        const bP = b.is_required ? 0 : b.is_desired ? 1 : 2;
        return aP !== bP ? aP - bP : b.total - a.total;
      })
      .map((st) => {
        const cls = st.is_required ? "req" : st.is_desired ? "des" : "other";
        return `<span class="opt-stat-tag ${cls}">${statIcon(st.part_id)}<span>${esc(statName(st.part_id))}</span> <span class="bp">+${st.total}</span></span>`;
      })
      .join("");

    card.innerHTML = `
      <div class="opt-rank ${rankClass}">#${comb.rank}</div>
      <div class="opt-card-body">
        <div class="opt-card-stats">${statTags}</div>
      </div>
      <div class="opt-card-plus">${esc(fmt(t.ui.combo_total, { n: comb.total_plus }))}</div>`;

    card.onclick = () => openModal(comb);
    results.appendChild(card);
  });
}

// --- Modal ---

function openModal(comb: Combination) {
  const bd = $("modal-bd");
  const body = $("modal-body");
  $("modal-title").textContent = fmt(t.ui.modal_rank_title, { rank: comb.rank });

  const modsHtml = comb.modules
    .map((m) => {
      const statsHtml = m.stats
        .map(
          (s) => `
          <div class="srow">
            ${statIcon(s.part_id)}<span class="sname">${esc(statName(s.part_id))}</span>
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
        ? `<span class="type-req">${esc(t.ui.modal_main)}</span>`
        : desIds.has(pid)
          ? `<span class="type-des">${esc(t.ui.modal_sub)}</span>`
          : "";
      return `
      <tr>
        <td>${statIcon(pid)} ${esc(statName(pid))}</td>
        <td class="val">+${total}</td>
        <td>${typeTag}</td>
      </tr>`;
    })
    .join("");

  const modalSectionTitle2 = document.createElement("div");
  modalSectionTitle2.className = "modal-section-title";
  modalSectionTitle2.textContent = t.ui.modal_stat_total;
  const grandTotalSpan = document.createElement("span");
  grandTotalSpan.style.cssText = "font-weight:400;font-size:11px;color:var(--tx2);text-transform:none;letter-spacing:0";
  grandTotalSpan.textContent = fmt(t.ui.modal_grand_total, { n: comb.total_plus });
  modalSectionTitle2.appendChild(document.createTextNode(" "));
  modalSectionTitle2.appendChild(grandTotalSpan);

  body.innerHTML = `
    <div class="modal-section">
      <div class="modal-section-title">${esc(t.ui.modal_used_modules)}</div>
      <div class="modal-modules">${modsHtml}</div>
    </div>
    <div class="modal-section" id="modal-stat-section">
      <table class="modal-table">
        <thead><tr><th>${esc(t.ui.modal_stat)}</th><th>${esc(t.ui.modal_value)}</th><th>${esc(t.ui.modal_category)}</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;

  const statSection = body.querySelector("#modal-stat-section")!;
  statSection.insertBefore(modalSectionTitle2, statSection.firstChild);

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
    rarity: t.rarity[qualityToRarity(m.quality)],
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

function generateExportCsv(): string {
  const BOM = "\uFEFF";
  const maxStats = allModules.reduce((mx, m) => Math.max(mx, m.stats.length), 0);
  const statCols = Math.max(maxStats, 3);

  const headers: string[] = [t.ui.csv_id, t.ui.csv_type, t.ui.csv_rarity];
  for (let i = 1; i <= statCols; i++) {
    headers.push(`status_${i}`, `value_${i}`);
  }
  headers.push(t.ui.csv_total, t.ui.csv_date);

  const rows: string[] = [headers.join(",")];

  for (const m of allModules) {
    const cols: (string | number)[] = [
      m.uuid,
      configIdToType(m.config_id),
      t.rarity[qualityToRarity(m.quality)],
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

// --- Language loading ---
async function loadLanguage(lang: string): Promise<void> {
  if (lang === "ko") {
    setLang(KO);
    return;
  }
  if (lang === "en") {
    setLang(EN);
    return;
  }
  if (lang === "custom") {
    try {
      const json = await invoke<string>("get_custom_language");
      setLang(mergeLang(JSON.parse(json)));
    } catch {
      // custom_lang.json が存在しない場合は日本語デフォルトで作成
      await invoke("save_custom_language", { content: JSON.stringify(JA, null, 2) });
      setLang(JA);
    }
    return;
  }
  setLang(JA);
}

// --- Init ---
async function init() {
  const appWindow = getCurrentWindow();

  // Pin toggle (always on top)
  const pinToggle = $("pin-toggle");
  pinToggle.onclick = async () => {
    const next = !pinToggle.classList.contains("active");
    await appWindow.setAlwaysOnTop(next);
    pinToggle.classList.toggle("active", next);
  };

  // Menu button
  $("menu-btn").onclick = () => {
    $("menu-modal-bd").classList.add("on");
  };
  $("menu-modal-close").onclick = () => {
    $("menu-modal-bd").classList.remove("on");
  };
  $("menu-modal-bd").onclick = (e) => {
    if (e.target === $("menu-modal-bd")) $("menu-modal-bd").classList.remove("on");
  };

  const menuExport = async (format: string) => {
    const content = format === "json" ? generateExportJson() : generateExportCsv();
    try {
      await invoke("export_to_file", { format, content });
    } catch (err) {
      console.error("export error:", err);
    }
  };
  $("menu-export-json").onclick = () => menuExport("json");
  $("menu-export-csv").onclick = () => menuExport("csv");

  $("menu-clear-data").onclick = () => {
    $("clear-data-bd").classList.add("on");
  };
  $("clear-data-close").onclick = () => {
    $("clear-data-bd").classList.remove("on");
  };
  $("clear-data-cancel").onclick = () => {
    $("clear-data-bd").classList.remove("on");
  };
  $("clear-data-ok").onclick = async () => {
    localStorage.clear();
    await invoke("clear_app_data");
  };

  // Tabs
  document.querySelectorAll<HTMLElement>(".tab").forEach((tabEl) => {
    tabEl.onclick = () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((x) => x.classList.remove("active"));
      tabEl.classList.add("active");
      $("panel-" + tabEl.dataset.tab!).classList.add("active");
    };
  });

  // Filter dropdown
  $("filter-btn").onclick = (e) => {
    openFilterMultiFly(e.currentTarget as HTMLElement);
  };

  // AND/OR toggle
  const modeBtn = $("filter-mode");
  modeBtn.onclick = () => {
    filterMode = filterMode === "and" ? "or" : "and";
    modeBtn.textContent = filterMode.toUpperCase();
    modeBtn.classList.toggle("or", filterMode === "or");
    renderGrid();
  };

  // Sort add
  $("add-s").onclick = (e) => {
    const ex = new Set(sortKeys.map((s) => s.k));
    const extraItems: { label: string; val: string; disabled: boolean }[] = [
      { label: t.ui.sort_date, val: "date", disabled: ex.has("date") },
      { label: t.ui.sort_rarity, val: "rarity", disabled: ex.has("rarity") },
      { label: t.ui.sort_total, val: "total", disabled: ex.has("total") },
    ];
    const allStatIds = Object.keys(t.stat_names).map(Number);
    const statItems = allStatIds.map((pid) => ({
      label: statName(pid),
      val: String(pid),
      disabled: ex.has(String(pid)),
    }));
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

  $("opt-btn-req").onclick = (e) => {
    openOptMultiFly(e.currentTarget as HTMLElement, "req");
  };
  $("opt-btn-des").onclick = (e) => {
    openOptMultiFly(e.currentTarget as HTMLElement, "des");
  };
  $("opt-btn-excl").onclick = (e) => {
    openOptMultiFly(e.currentTarget as HTMLElement, "excl");
  };

  $("opt-quality").onchange = () => saveOptState();
  $("opt-run").onclick = () => runOptimize();

  // 探索速度インフォモーダル
  $("speed-info-btn").onclick = () => {
    const body = $("speed-info-body");
    while (body.firstChild) body.removeChild(body.firstChild);
    const desc = document.createElement("p");
    desc.textContent = t.ui.speed_info_desc;
    desc.style.cssText = "margin:0 0 12px;font-size:13px;line-height:1.6";
    body.appendChild(desc);
    const items = [t.ui.speed_info_standard, t.ui.speed_info_precise, t.ui.speed_info_most_precise];
    const ul = document.createElement("ul");
    ul.style.cssText = "margin:0 0 12px;padding-left:20px;font-size:13px;line-height:1.8";
    items.forEach((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      ul.appendChild(li);
    });
    body.appendChild(ul);
    const note = document.createElement("p");
    note.textContent = t.ui.speed_info_note;
    note.style.cssText = "margin:0;font-size:12px;color:#e8a735;line-height:1.6";
    body.appendChild(note);
    $("speed-info-bd").classList.add("on");
  };
  $("speed-info-close").onclick = () => $("speed-info-bd").classList.remove("on");
  $("speed-info-bd").onclick = (e) => {
    if (e.target === $("speed-info-bd")) $("speed-info-bd").classList.remove("on");
  };

  // --- パターン管理 ---
  await loadPatternsFromBackend();
  renderPatternSelect();

  $("pattern-load").onclick = () => {
    const idx = Number(($<HTMLSelectElement>("pattern-select")).value);
    if (!isNaN(idx) && idx >= 0) loadPattern(idx);
  };

  $("pattern-save").onclick = async () => {
    const name = prompt(t.ui.pattern_prompt);
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
    if (!confirm(fmt(t.ui.pattern_delete_confirm, { name: p.name }))) return;
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
  updateOptBtnLabel("req");
  updateOptBtnLabel("des");
  updateOptBtnLabel("excl");
  updateOptRunBtn();

  // バックエンドからのイベントを監視
  await listen("modules-updated", () => {
    loadModules();
  });

  await listen("server-found", () => {
    $("sb-monitor").textContent = t.ui.server_found;
  });

  // --- 設定管理 ---
  type AppSettings = {
    auto_monitor: boolean;
    show_monitor_confirm: boolean;
    theme: string;
    language: string;
    language_configured: boolean;
    background_mode: boolean;
  };
  let appSettings: AppSettings = await invoke("get_settings");

  // --- テーマ管理 ---
  const applyTheme = (theme: string) => {
    let resolved = theme;
    if (theme === "system") {
      resolved = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    document.documentElement.setAttribute("data-theme", resolved);
    let meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'color-scheme';
      document.head.appendChild(meta);
    }
    meta.content = resolved;
    document.querySelectorAll<HTMLSelectElement>("select").forEach((sel) => {
      sel.style.setProperty("color-scheme", resolved);
    });
  };

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (appSettings.theme === "system") applyTheme("system");
  });

  applyTheme(appSettings.theme);

  const saveSettings = async (patch: Partial<AppSettings>) => {
    appSettings = { ...appSettings, ...patch };
    await invoke("update_settings", { settings: appSettings });
  };

  // --- 起動時ネットワーク監視トグル ---
  const autoMonitorToggle = $("menu-toggle-auto-monitor");
  autoMonitorToggle.classList.toggle("active", appSettings.auto_monitor);
  autoMonitorToggle.onclick = () => {
    const next = !appSettings.auto_monitor;
    autoMonitorToggle.classList.toggle("active", next);
    saveSettings({ auto_monitor: next });
  };

  // --- バックグラウンドモードトグル ---
  const bgModeToggle = $("menu-toggle-background-mode");
  bgModeToggle.classList.toggle("active", appSettings.background_mode);
  bgModeToggle.onclick = () => {
    const next = !appSettings.background_mode;
    bgModeToggle.classList.toggle("active", next);
    saveSettings({ background_mode: next });
  };

  // --- テーマ select ---
  const themeSelect = $<HTMLSelectElement>("menu-theme-select");
  themeSelect.value = appSettings.theme;
  themeSelect.onchange = () => {
    applyTheme(themeSelect.value);
    saveSettings({ theme: themeSelect.value });
  };

  // --- 言語切替 ---
  const switchLanguage = async (lang: string) => {
    await saveSettings({ language: lang });
    await loadLanguage(lang);
    applyI18n();
    renderGrid();
  };

  const langSelect = $<HTMLSelectElement>("menu-lang-select");
  langSelect.value = appSettings.language ?? "ja";

  // --- カスタム言語エディタ ---
  const updateLangEditBtn = () => {
    $("menu-lang-edit-btn").style.display = langSelect.value === "custom" ? "" : "none";
  };
  langSelect.onchange = () => {
    switchLanguage(langSelect.value);
    updateLangEditBtn();
  };
  updateLangEditBtn();

  type CLSection = "stat" | "type" | "rarity" | "ui";
  let clData = mergeLang({});
  let clSection: CLSection = "stat";
  let clQuery = "";

  const COPY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

  function renderCLBody() {
    type RowDef = { key: string; def: string; val: string; set: (v: string) => void };
    const rows: RowDef[] = [];

    if (clSection === "stat") {
      Object.entries(JA.stat_names).forEach(([k, d]) => {
        rows.push({ key: k, def: d, val: clData.stat_names[k] ?? d, set: (v) => { clData.stat_names[k] = v; } });
      });
    } else if (clSection === "type") {
      Object.entries(JA.module_types).forEach(([k, d]) => {
        rows.push({ key: k, def: d, val: clData.module_types[k] ?? d, set: (v) => { clData.module_types[k] = v; } });
      });
    } else if (clSection === "rarity") {
      (["orange", "gold", "purple", "blue"] as const).forEach((k) => {
        rows.push({ key: k, def: JA.rarity[k], val: clData.rarity[k] ?? JA.rarity[k], set: (v) => { (clData.rarity as Record<string, string>)[k] = v; } });
      });
    } else {
      Object.entries(JA.ui).forEach(([k, d]) => {
        rows.push({ key: k, def: d, val: clData.ui[k] ?? d, set: (v) => { clData.ui[k] = v; } });
      });
    }

    const q = clQuery.toLowerCase();
    const filtered = q
      ? rows.filter((r) => r.key.toLowerCase().includes(q) || r.def.toLowerCase().includes(q) || r.val.toLowerCase().includes(q))
      : rows;

    const table = document.createElement("table");
    table.className = "custom-lang-table";
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    (["Key", "Default (Japanese)", "Translation"] as const).forEach((text, i) => {
      const th = document.createElement("th");
      if (i === 0) th.className = "cl-key";
      th.textContent = text;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    filtered.forEach((row) => {
      const tr = document.createElement("tr");

      const keyTd = document.createElement("td");
      keyTd.className = "cl-key";
      keyTd.textContent = row.key;
      tr.appendChild(keyTd);

      const defTd = document.createElement("td");
      defTd.className = "cl-default";
      const defInner = document.createElement("div");
      defInner.className = "cl-default-inner";
      const defText = document.createElement("span");
      defText.className = "cl-default-text";
      defText.textContent = row.def;
      defText.title = row.def;
      const copyBtn = document.createElement("button");
      copyBtn.className = "cl-copy-btn";
      copyBtn.innerHTML = COPY_SVG;
      copyBtn.title = "Copy";
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(row.def);
        copyBtn.classList.add("copied");
        copyBtn.textContent = "✓";
        setTimeout(() => {
          copyBtn.classList.remove("copied");
          copyBtn.innerHTML = COPY_SVG;
        }, 800);
      };
      defInner.appendChild(defText);
      defInner.appendChild(copyBtn);
      defTd.appendChild(defInner);
      tr.appendChild(defTd);

      const inputTd = document.createElement("td");
      const input = document.createElement("input");
      input.type = "text";
      input.className = "cl-input";
      input.value = row.val;
      input.placeholder = row.def;
      input.oninput = () => row.set(input.value);
      inputTd.appendChild(input);
      tr.appendChild(inputTd);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    const body = $("custom-lang-body");
    body.innerHTML = "";
    body.appendChild(table);
  }

  const openCustomLangEditor = async () => {
    try {
      const json = await invoke<string>("get_custom_language");
      clData = mergeLang(JSON.parse(json));
    } catch {
      clData = mergeLang({});
    }
    clSection = "stat";
    clQuery = "";
    $<HTMLInputElement>("custom-lang-search").value = "";
    document.querySelectorAll<HTMLElement>(".custom-lang-tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === "stat");
    });
    renderCLBody();
    $("custom-lang-bd").classList.add("on");
  };

  $("menu-lang-edit-btn").onclick = () => openCustomLangEditor();

  document.querySelectorAll<HTMLElement>(".custom-lang-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".custom-lang-tab").forEach((el) => el.classList.remove("active"));
      tab.classList.add("active");
      clSection = tab.dataset.tab as CLSection;
      renderCLBody();
    });
  });

  $<HTMLInputElement>("custom-lang-search").oninput = (e) => {
    clQuery = (e.target as HTMLInputElement).value;
    renderCLBody();
  };

  const closeCustomLangEditor = () => $("custom-lang-bd").classList.remove("on");
  $("custom-lang-close").onclick = closeCustomLangEditor;
  $("custom-lang-cancel").onclick = closeCustomLangEditor;

  $("custom-lang-save").onclick = async () => {
    await invoke("save_custom_language", { content: JSON.stringify(clData, null, 2) });
    closeCustomLangEditor();
    if (langSelect.value === "custom") {
      await loadLanguage("custom");
      applyI18n();
      renderGrid();
    }
  };

  $("custom-lang-import").onclick = () => {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".json";
    fileInput.onchange = async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        clData = mergeLang(JSON.parse(await file.text()));
        renderCLBody();
      } catch { /* 不正なJSONは無視 */ }
    };
    fileInput.click();
  };

  $("custom-lang-export").onclick = () => {
    const blob = new Blob([JSON.stringify(clData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "custom_lang.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  // --- 監視確認モーダル ---
  const openMonitorConfirm = (): Promise<{ confirmed: boolean; hide: boolean }> => {
    return new Promise((resolve) => {
      const bd = $("monitor-confirm-bd");
      const checkbox = $("monitor-confirm-hide") as HTMLInputElement;
      checkbox.checked = false;
      bd.classList.add("on");

      const cleanup = () => {
        bd.classList.remove("on");
        $("monitor-confirm-yes").onclick = null;
        $("monitor-confirm-no").onclick = null;
        $("monitor-confirm-close").onclick = null;
        bd.onclick = null;
      };

      $("monitor-confirm-yes").onclick = () => {
        cleanup();
        resolve({ confirmed: true, hide: checkbox.checked });
      };
      $("monitor-confirm-no").onclick = () => {
        cleanup();
        resolve({ confirmed: false, hide: checkbox.checked });
      };
      $("monitor-confirm-close").onclick = () => {
        cleanup();
        resolve({ confirmed: false, hide: false });
      };
      bd.onclick = (e) => {
        if (e.target === bd) {
          cleanup();
          resolve({ confirmed: false, hide: false });
        }
      };
    });
  };

  // キャプチャトグル
  const capToggle = $("cap-toggle") as HTMLButtonElement;
  capToggle.addEventListener("click", async () => {
    const isActive = capToggle.classList.contains("active");
    if (isActive) {
      await invoke("stop_capture_cmd");
      capToggle.classList.remove("active");
      $("sb-monitor").textContent = "";
    } else {
      if (!appSettings.auto_monitor && appSettings.show_monitor_confirm) {
        const result = await openMonitorConfirm();
        if (result.hide) {
          await saveSettings({ show_monitor_confirm: false });
        }
        if (result.confirmed) {
          await saveSettings({ auto_monitor: true });
        }
      }
      await invoke("start_capture_cmd");
      capToggle.classList.add("active");
      $("sb-monitor").textContent = t.ui.server_searching;
    }
  });

  // 起動時に自動監視が有効ならトグルをON状態にする
  {
    const status: { capturing: boolean; server_found: boolean } = await invoke("get_monitor_status");
    if (status.capturing) {
      capToggle.classList.add("active");
      $("sb-monitor").textContent = status.server_found ? t.ui.server_found : t.ui.server_searching;
    }
  }

  updateFilterBtnLabel();
  renderSChips();
  loadModules();
}

async function main() {
  // ウィンドウ操作は最初に登録（言語選択モーダル表示中も動作させるため）
  const appWindow = getCurrentWindow();
  $("win-minimize").onclick = async () => {
    const bgEnabled = $("menu-toggle-background-mode").classList.contains("active");
    const capturing = $("cap-toggle").classList.contains("active");
    if (bgEnabled && capturing) {
      await invoke("enter_background_mode");
    } else {
      appWindow.minimize();
    }
  };
  $("win-close").onclick = () => appWindow.close();

  // 設定から言語を読み込んでi18nを初期化してからDOMを更新
  type SettingsMain = { language?: string; language_configured?: boolean; [key: string]: unknown };
  const settings = await invoke<SettingsMain>("get_settings").catch(() => ({} as SettingsMain));

  let initLang = settings.language ?? "ja";

  // 初回起動時: 言語選択モーダルを表示
  if (!settings.language_configured) {
    const locale = await invoke<string>("get_system_locale").catch(() => "ja");
    const suggested = locale.startsWith("ko") ? "ko" : locale.startsWith("en") ? "en" : "ja";
    const sel = $<HTMLSelectElement>("firstrun-lang-select");
    sel.value = suggested;
    $("firstrun-bd").classList.add("on");
    initLang = await new Promise<string>((resolve) => {
      $("firstrun-save").onclick = async () => {
        const lang = sel.value;
        await invoke("update_settings", { settings: { ...settings, language: lang, language_configured: true } });
        $("firstrun-bd").classList.remove("on");
        resolve(lang);
      };
    });
  }

  await loadLanguage(initLang);
  applyI18n();
  await init();
}

document.addEventListener("DOMContentLoaded", main);
