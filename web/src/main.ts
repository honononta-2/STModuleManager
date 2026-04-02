import {
  STAT_ICONS, ALL_STAT_IDS, configIdToIcon,
} from "@shared/stats";
import type {
  Combination, CombinationModule, ModuleInput, OptimizeRequest,
  OptimizeResponse, StatEntry, StatTotal,
} from "@shared/types";
import { processScreenshot } from "./ocr";
import {
  t, fmt, statName, applyI18n, initLang, saveLang, getSavedLang,
  JA, migrateStatNamesToIds,
} from "./i18n";

// --- Helpers ---
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function positionFlyout(fl: HTMLElement, anchor: HTMLElement) {
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  let left = r.left;
  fl.style.top = r.bottom + 4 + "px";
  if (vw <= 600) {
    fl.style.left = "8px";
    fl.style.right = "8px";
    fl.style.maxWidth = "";
  } else {
    const flyW = fl.offsetWidth || 176;
    if (left + flyW > vw - 8) left = vw - flyW - 8;
    if (left < 8) left = 8;
    fl.style.left = left + "px";
    fl.style.right = "";
  }
}

function statIcon(partId: number): string {
  const icon = STAT_ICONS[partId];
  return icon ? `<img class="sicon" src="/icons/${icon}" alt="">` : "";
}

type Rarity = "orange" | "gold" | "purple" | "blue";
const RARITY_ORDER: Record<Rarity, number> = { orange: 4, gold: 3, purple: 2, blue: 1 };

function qualityToRarity(q: number | null): Rarity {
  if (q === 5) return "gold";
  if (q === 4) return "gold";
  if (q === 3) return "purple";
  return "blue";
}

function moduleIconHtml(configId: number | null): string {
  const info = configIdToIcon(configId);
  if (!info) return "";
  return `<div class="mod-icon-wrap">
    <img class="mod-icon-bg" src="/icons/rarity${info.bgRarity}.png" alt="">
    <img class="mod-icon-fg" src="/icons/${info.icon}" alt="">
  </div>`;
}

function configIdToComponents(configId: number | null): { typeDigit: number; raritySub: number } | null {
  if (configId == null) return null;
  const lower = configId % 1000;
  return { typeDigit: Math.floor(lower / 100), raritySub: lower % 100 };
}

function buildConfigId(typeDigit: number, raritySub: number): number {
  return 5500000 + typeDigit * 100 + raritySub;
}

const RARITY_SUB_TO_QUALITY: Record<number, number> = { 1: 2, 2: 3, 3: 4, 4: 4 };

const MODULE_TYPE_PREFIXES = [55001, 55002, 55003] as const;

// --- State ---
let modules: ModuleInput[] = [];

let filterRarities: Rarity[] = [];
let filterStats: number[] = [];
let filterTypes: number[] = [];
let filterMode: "and" | "or" = "and";
let sortKeys: { k: string; d: number }[] = [];

let optRequired: number[] = [];
let optDesired: number[] = [];
let optExcluded: number[] = [];
let minQuality = 3;

// --- Multi Web Worker ---
const numWorkers = Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 2));
const workers: Worker[] = [];
for (let i = 0; i < numWorkers; i++) {
  workers.push(new Worker(new URL("./wasm-worker.ts", import.meta.url), { type: "module" }));
}

// ========== Storage ==========
function saveModulesToStorage() {
  try { localStorage.setItem("modules", JSON.stringify(modules)); } catch { /* quota */ }
}
function loadModulesFromStorage() {
  try {
    const saved = localStorage.getItem("modules");
    if (saved) modules = JSON.parse(saved);
  } catch { /* ignore */ }
}

// ========== Shared select option builders ==========

function typeSelectOptions(selectedDigit: number): string {
  return MODULE_TYPE_PREFIXES.map((p) => {
    const digit = p % 10;
    return `<option value="${digit}"${digit === selectedDigit ? " selected" : ""}>${t.module_types[String(p)]}</option>`;
  }).join("");
}

function raritySubSelectOptions(selectedSub: number): string {
  const opts = [
    { value: 1, key: "rarity_sub_blue" },
    { value: 2, key: "rarity_sub_purple" },
    { value: 3, key: "rarity_sub_gold_a" },
    { value: 4, key: "rarity_sub_gold_b" },
  ];
  return opts.map((o) => `<option value="${o.value}"${o.value === selectedSub ? " selected" : ""}>${t.ui[o.key]}</option>`).join("");
}

function statSelectOptions(selectedId?: number): string {
  return ALL_STAT_IDS.map((id) =>
    `<option value="${id}"${id === selectedId ? " selected" : ""}>${statName(id)}</option>`
  ).join("");
}

// ========== Grid rendering ==========

function renderGrid() {
  let ms = [...modules];

  if (filterRarities.length > 0) {
    ms = ms.filter((m) => filterRarities.includes(qualityToRarity(m.quality)));
  }
  if (filterTypes.length > 0) {
    ms = ms.filter((m) => {
      if (m.config_id == null) return false;
      const prefix = Math.floor(m.config_id / 100);
      return filterTypes.includes(prefix);
    });
  }
  if (filterStats.length > 0) {
    ms = filterMode === "and"
      ? ms.filter((m) => filterStats.every((id) => m.stats.some((s) => s.part_id === id)))
      : ms.filter((m) => filterStats.some((id) => m.stats.some((s) => s.part_id === id)));
  }

  ms.sort((a, b) => {
    for (const s of sortKeys) {
      let va: number, vb: number;
      if (s.k === "rarity") {
        va = RARITY_ORDER[qualityToRarity(a.quality)];
        vb = RARITY_ORDER[qualityToRarity(b.quality)];
      } else if (s.k === "total") {
        va = a.stats.reduce((sum, x) => sum + x.value, 0);
        vb = b.stats.reduce((sum, x) => sum + x.value, 0);
      } else {
        const partId = Number(s.k);
        va = a.stats.find((x) => x.part_id === partId)?.value ?? 0;
        vb = b.stats.find((x) => x.part_id === partId)?.value ?? 0;
      }
      if (va < vb) return s.d;
      if (va > vb) return -s.d;
    }
    return 0;
  });

  const g = $<HTMLDivElement>("grid");
  g.textContent = "";

  if (!ms.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const icon = document.createElement("div");
    icon.style.cssText = "font-size:24px;opacity:0.25";
    icon.textContent = "\u25CB";
    const msg = document.createElement("div");
    msg.style.fontSize = "13px";
    msg.textContent = t.ui.no_modules;
    empty.appendChild(icon);
    empty.appendChild(msg);
    g.appendChild(empty);
    $("sb-n").textContent = fmt(t.ui.n_modules, { count: 0 });
    $("sb-i").textContent = "";
    return;
  }

  ms.forEach((m, i) => {
    const c = document.createElement("div");
    c.className = "card";
    c.style.animationDelay = `${Math.min(i, 16) * 14}ms`;
    const r = qualityToRarity(m.quality);

    // card-head
    const head = document.createElement("div");
    head.className = "card-head";
    const iconWrap = document.createElement("span");
    iconWrap.innerHTML = moduleIconHtml(m.config_id);
    head.appendChild(iconWrap.firstElementChild || document.createTextNode(""));
    const badge = document.createElement("span");
    badge.className = `rbadge ${r}`;
    badge.textContent = t.rarity[r];
    head.appendChild(badge);
    const editBtn = document.createElement("button");
    editBtn.className = "card-edit-btn";
    editBtn.title = t.ui.modal_edit;
    editBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`;
    editBtn.onclick = (e) => { e.stopPropagation(); openEditModal(m.uuid); };
    head.appendChild(editBtn);
    c.appendChild(head);

    const divider = document.createElement("div");
    divider.className = "divider";
    c.appendChild(divider);

    const statsDiv = document.createElement("div");
    statsDiv.className = "stats";
    m.stats.forEach((s) => {
      const srow = document.createElement("div");
      srow.className = "srow";
      const iconImg = statIcon(s.part_id);
      if (iconImg) {
        const tmp = document.createElement("span");
        tmp.innerHTML = iconImg;
        if (tmp.firstElementChild) srow.appendChild(tmp.firstElementChild);
      }
      const sname = document.createElement("span");
      sname.className = "sname";
      sname.textContent = statName(s.part_id);
      srow.appendChild(sname);
      const sbarW = document.createElement("div");
      sbarW.className = "sbar-w";
      const sbar = document.createElement("div");
      sbar.className = "sbar";
      sbar.style.width = `${s.value * 10}%`;
      sbarW.appendChild(sbar);
      srow.appendChild(sbarW);
      const sval = document.createElement("span");
      sval.className = "sval";
      sval.textContent = `+${s.value}`;
      srow.appendChild(sval);
      statsDiv.appendChild(srow);
    });
    c.appendChild(statsDiv);
    g.appendChild(c);
  });

  $("sb-n").textContent = fmt(t.ui.n_modules, { count: ms.length });
  const info: string[] = [];
  const filterCount = filterRarities.length + filterTypes.length + filterStats.length;
  if (filterCount) info.push(`${fmt(t.ui.filter_info, { count: filterCount })}(${filterMode.toUpperCase()})`);
  $("sb-i").textContent = info.join("\u3000");
}

// ========== Filter flyout ==========

function updateFilterBtnLabel() {
  const count = filterRarities.length + filterTypes.length + filterStats.length;
  const btn = $("filter-btn");
  btn.textContent = count > 0 ? fmt(t.ui.filter_count, { count }) : t.ui.filter_none;
  btn.classList.toggle("has-items", count > 0);
}

function addFlySection(
  fl: HTMLElement, title: string,
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

const RARITY_FILTER_VALUES: Rarity[] = ["gold", "purple", "blue"];

function openFilterMultiFly(anchor: HTMLElement) {
  const fl = $("fly-filter");
  if (fl.classList.contains("on")) { closeFly(); return; }
  closeFly();
  fl.innerHTML = "";
  const refresh = () => { updateFilterBtnLabel(); renderGrid(); };

  addFlySection(fl, t.ui.fly_rarity,
    RARITY_FILTER_VALUES.map((r) => ({ label: t.rarity[r], checked: filterRarities.includes(r) })),
    (i, checked) => {
      const val = RARITY_FILTER_VALUES[i];
      if (checked) filterRarities.push(val);
      else { const idx = filterRarities.indexOf(val); if (idx >= 0) filterRarities.splice(idx, 1); }
      refresh();
    },
  );

  const typeEntries = MODULE_TYPE_PREFIXES.map((p) => ({ prefix: p, label: t.module_types[String(p)] ?? "" }));
  addFlySection(fl, t.ui.fly_type,
    typeEntries.map((te) => ({ label: te.label, checked: filterTypes.includes(te.prefix) })),
    (i, checked) => {
      const val = typeEntries[i].prefix;
      if (checked) filterTypes.push(val);
      else { const idx = filterTypes.indexOf(val); if (idx >= 0) filterTypes.splice(idx, 1); }
      refresh();
    },
  );

  addFlySection(fl, t.ui.fly_stat,
    ALL_STAT_IDS.map((id) => ({ label: statName(id), checked: filterStats.includes(id) })),
    (i, checked) => {
      const val = ALL_STAT_IDS[i];
      if (checked) filterStats.push(val);
      else { const idx = filterStats.indexOf(val); if (idx >= 0) filterStats.splice(idx, 1); }
      refresh();
    },
  );

  positionFlyout(fl, anchor);
  fl.classList.add("on");
  $("bd").classList.add("on");
}

// ========== Sort chips ==========

function renderSChips() {
  const c = $("schips");
  c.textContent = "";
  sortKeys.forEach((s) => {
    const lbl = s.k === "rarity" ? t.ui.sort_rarity : s.k === "total" ? t.ui.sort_total : statName(Number(s.k));
    const el = document.createElement("div");
    el.className = "schip on";
    const labelSpan = document.createElement("span");
    labelSpan.textContent = lbl;
    el.appendChild(labelSpan);
    const arrSpan = document.createElement("span");
    arrSpan.className = "arr";
    arrSpan.textContent = s.d === 1 ? "\u2193" : "\u2191";
    el.appendChild(arrSpan);
    const rm = document.createElement("button");
    rm.className = "schip-rm";
    rm.textContent = "\u00d7";
    rm.onclick = (e) => {
      e.stopPropagation();
      const idx = sortKeys.indexOf(s);
      if (idx >= 0) sortKeys.splice(idx, 1);
      renderSChips();
      renderGrid();
    };
    el.appendChild(rm);
    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("schip-rm")) return;
      s.d *= -1;
      renderSChips();
      renderGrid();
    });
    c.appendChild(el);
  });
}

// ========== Flyout system ==========

function openFly(
  flyId: string, anchor: HTMLElement,
  items: { label: string; val: string; disabled: boolean }[],
  onPick: (item: { label: string; val: string }) => void,
) {
  closeFly();
  const fl = $(flyId);
  fl.innerHTML = "";
  items.forEach((it) => {
    const el = document.createElement("div");
    el.className = "fitem" + (it.disabled ? " dim" : "");
    el.textContent = it.label;
    if (!it.disabled) el.onclick = () => { closeFly(); onPick(it); };
    fl.appendChild(el);
  });
  positionFlyout(fl, anchor);
  fl.classList.add("on");
  $("bd").classList.add("on");
}

function closeFly() {
  document.querySelectorAll(".flyout").forEach((f) => f.classList.remove("on"));
  $("bd").classList.remove("on");
}

// ========== Optimizer UI ==========

const OPT_STATE_KEY = "opt-last-state";
const OPT_PATTERNS_KEY = "opt-patterns";
const OPT_RESULTS_KEY = "opt-last-results";

interface OptPattern {
  name: string;
  required: number[];
  desired: number[];
  excluded: number[];
  quality: number;
}

function saveOptState() {
  const quality = Number($<HTMLSelectElement>("opt-quality").value);
  localStorage.setItem(OPT_STATE_KEY, JSON.stringify({
    required: optRequired, desired: optDesired, excluded: optExcluded, quality,
  }));
}

function restoreOptState() {
  const raw = localStorage.getItem(OPT_STATE_KEY);
  if (!raw) return;
  try {
    const s = JSON.parse(raw);
    if (Array.isArray(s.required)) optRequired = migrateStatNamesToIds(s.required).filter((id) => ALL_STAT_IDS.includes(id));
    if (Array.isArray(s.desired)) optDesired = migrateStatNamesToIds(s.desired).filter((id) => ALL_STAT_IDS.includes(id));
    if (Array.isArray(s.excluded)) optExcluded = migrateStatNamesToIds(s.excluded).filter((id) => ALL_STAT_IDS.includes(id));
    if (s.quality) $<HTMLSelectElement>("opt-quality").value = String(s.quality);
  } catch { /* ignore */ }
}

function getPatterns(): OptPattern[] {
  const raw = localStorage.getItem(OPT_PATTERNS_KEY);
  if (!raw) return [];
  try {
    const patterns: OptPattern[] = JSON.parse(raw);
    return patterns.map((p) => ({
      ...p,
      required: migrateStatNamesToIds(p.required),
      desired: migrateStatNamesToIds(p.desired),
      excluded: migrateStatNamesToIds(p.excluded),
    }));
  } catch { return []; }
}

function savePatterns(patterns: OptPattern[]) {
  localStorage.setItem(OPT_PATTERNS_KEY, JSON.stringify(patterns));
}

function renderPatternSelect() {
  const sel = $<HTMLSelectElement>("pattern-select");
  const patterns = getPatterns();
  sel.textContent = "";
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
  updatePatternButtons();
}

function updatePatternButtons() {
  const sel = $<HTMLSelectElement>("pattern-select");
  const hasSelection = sel.value !== "";
  ($("pattern-delete") as HTMLButtonElement).disabled = !hasSelection;
  ($("pattern-load") as HTMLButtonElement).disabled = !hasSelection;
}

function loadPattern(idx: number) {
  const patterns = getPatterns();
  const p = patterns[idx];
  if (!p) return;
  optRequired = p.required.filter((id) => ALL_STAT_IDS.includes(id));
  optDesired = p.desired.filter((id) => ALL_STAT_IDS.includes(id));
  optExcluded = p.excluded.filter((id) => ALL_STAT_IDS.includes(id));
  if (p.quality) $<HTMLSelectElement>("opt-quality").value = String(p.quality);
  updateOptBtnLabel("req");
  updateOptBtnLabel("des");
  updateOptBtnLabel("excl");
  updateOptRunBtn();
  saveOptState();
}

function updateOptBtnLabel(category: "req" | "des" | "excl") {
  const btnId = { req: "opt-btn-req", des: "opt-btn-des", excl: "opt-btn-excl" }[category];
  const items = { req: optRequired, des: optDesired, excl: optExcluded }[category];
  const btn = $(btnId);
  btn.textContent = items.length > 0 ? fmt(t.ui.filter_count, { count: items.length }) : t.ui.filter_none;
  btn.classList.toggle("has-items", items.length > 0);
}

function openOptMultiFly(anchor: HTMLElement, category: "req" | "des" | "excl") {
  const fl = $("fly-multi");
  if (fl.classList.contains("on") && fl.dataset.category === category) { closeFly(); return; }
  closeFly();
  fl.dataset.category = category;
  const current = { req: optRequired, des: optDesired, excl: optExcluded }[category];
  const others = (["req", "des", "excl"] as const)
    .filter((k) => k !== category)
    .flatMap((k) => ({ req: optRequired, des: optDesired, excl: optExcluded }[k]));
  const otherSet = new Set(others);

  fl.innerHTML = "";
  ALL_STAT_IDS.forEach((id) => {
    const isSelected = current.includes(id);
    const isOther = otherSet.has(id);
    const el = document.createElement("label");
    el.className = "fitem-check" + (isOther ? " dim" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = isSelected;
    cb.disabled = isOther;
    if (!isOther) {
      cb.onchange = () => {
        if (cb.checked) current.push(id);
        else { const idx = current.indexOf(id); if (idx >= 0) current.splice(idx, 1); }
        updateOptBtnLabel(category);
        updateOptRunBtn();
        saveOptState();
      };
    }
    const span = document.createElement("span");
    span.textContent = statName(id);
    el.appendChild(cb);
    el.appendChild(span);
    fl.appendChild(el);
  });

  positionFlyout(fl, anchor);
  fl.classList.add("on");
  $("bd").classList.add("on");
}

function updateOptRunBtn() {
  $<HTMLButtonElement>("opt-run").disabled = optRequired.length === 0 || modules.length < 4;
}

// ========== Optimize (Web Workers) ==========

let optOverlay: HTMLElement | null = null;

function runOptimize() {
  const btn = $<HTMLButtonElement>("opt-run");
  btn.classList.add("loading");
  btn.textContent = t.ui.btn_running;
  $("opt-empty").style.display = "none";
  $("opt-results").style.display = "none";

  optOverlay = createLoadingOverlay();
  $("opt-scroll").appendChild(optOverlay);

  const quality = Number($<HTMLSelectElement>("opt-quality").value);
  let completed = 0;
  let errored = false;
  const allCombinations: Combination[] = [];
  let filteredCount = 0;
  let totalModules = 0;

  for (let i = 0; i < numWorkers; i++) {
    const speedMode = $<HTMLSelectElement>("opt-speed").value;
    const req: OptimizeRequest = {
      required_stats: [...optRequired],
      desired_stats: [...optDesired],
      excluded_stats: [...optExcluded],
      min_quality: quality,
      speed_mode: speedMode as OptimizeRequest["speed_mode"],
      worker_id: i,
      num_workers: numWorkers,
    };

    workers[i].onmessage = (e: MessageEvent) => {
      const { type, data, error } = e.data;
      if (errored) return;
      if (type === "error") {
        errored = true;
        showToast(error, "error");
        finishOptimize();
        return;
      }
      if (type === "result") {
        const res = data as OptimizeResponse;
        allCombinations.push(...res.combinations);
        filteredCount = res.filtered_count;
        totalModules = res.total_modules;
        completed++;
        if (completed === numWorkers) {
          allCombinations.sort((a, b) => b.score - a.score);
          const top10 = allCombinations.slice(0, 10).map((c, idx) => ({ ...c, rank: idx + 1 }));
          renderOptResults({ combinations: top10, filtered_count: filteredCount, total_modules: totalModules });
          finishOptimize();
        }
      }
    };

    workers[i].postMessage({ type: "optimize", modules, request: req });
  }
}

function finishOptimize() {
  optOverlay?.remove();
  optOverlay = null;
  const btn = $<HTMLButtonElement>("opt-run");
  btn.classList.remove("loading");
  btn.textContent = t.ui.btn_run;
}

// ========== Opt Results ==========

function renderOptResults(res: OptimizeResponse) {
  const empty = $("opt-empty");
  const results = $("opt-results");

  if (res.combinations.length === 0) {
    results.style.display = "none";
    empty.style.display = "flex";
    empty.textContent = "";
    const emptyIcon = document.createElement("div");
    emptyIcon.style.cssText = "font-size:28px;opacity:0.22";
    emptyIcon.textContent = "\u25CB";
    const emptyMsg = document.createElement("div");
    emptyMsg.textContent = t.ui.no_result;
    empty.appendChild(emptyIcon);
    empty.appendChild(emptyMsg);
    try { localStorage.setItem(OPT_RESULTS_KEY, JSON.stringify(res)); } catch { /* quota */ }
    return;
  }

  empty.style.display = "none";
  results.style.display = "flex";
  results.textContent = "";

  const info = document.createElement("div");
  info.className = "opt-info";
  info.textContent = fmt(t.ui.result_info, { total: res.total_modules, filtered: res.filtered_count, count: res.combinations.length });
  results.appendChild(info);

  res.combinations.forEach((comb) => {
    const card = document.createElement("div");
    card.className = "opt-card";
    card.style.animationDelay = `${(comb.rank - 1) * 30}ms`;
    const rankClass = comb.rank === 1 ? "r1" : comb.rank === 2 ? "r2" : comb.rank === 3 ? "r3" : "";

    const rankDiv = document.createElement("div");
    rankDiv.className = `opt-rank ${rankClass}`;
    rankDiv.textContent = `#${comb.rank}`;
    card.appendChild(rankDiv);

    const bodyDiv = document.createElement("div");
    bodyDiv.className = "opt-card-body";
    const statsDiv = document.createElement("div");
    statsDiv.className = "opt-card-stats";

    comb.stat_totals
      .slice()
      .sort((a, b) => {
        const aP = a.is_required ? 0 : a.is_desired ? 1 : 2;
        const bP = b.is_required ? 0 : b.is_desired ? 1 : 2;
        return aP !== bP ? aP - bP : b.total - a.total;
      })
      .forEach((st) => {
        const cls = st.is_required ? "req" : st.is_desired ? "des" : "other";
        const tag = document.createElement("span");
        tag.className = `opt-stat-tag ${cls}`;
        const iconStr = statIcon(st.part_id);
        if (iconStr) {
          const tmp = document.createElement("span");
          tmp.innerHTML = iconStr;
          if (tmp.firstElementChild) tag.appendChild(tmp.firstElementChild);
        }
        const nameSpan = document.createElement("span");
        nameSpan.textContent = statName(st.part_id);
        tag.appendChild(nameSpan);
        const bp = document.createElement("span");
        bp.className = "bp";
        bp.textContent = ` +${st.total}`;
        tag.appendChild(bp);
        statsDiv.appendChild(tag);
      });

    bodyDiv.appendChild(statsDiv);
    card.appendChild(bodyDiv);

    const plusDiv = document.createElement("div");
    plusDiv.className = "opt-card-plus";
    plusDiv.textContent = fmt(t.ui.combo_total, { n: comb.total_plus });
    card.appendChild(plusDiv);

    card.onclick = () => openModal(comb);
    results.appendChild(card);
  });

  try { localStorage.setItem(OPT_RESULTS_KEY, JSON.stringify(res)); } catch { /* quota */ }
}

function restoreOptResults() {
  const raw = localStorage.getItem(OPT_RESULTS_KEY);
  if (!raw) return;
  try {
    const res: OptimizeResponse = JSON.parse(raw);
    if (res.combinations && res.combinations.length > 0) {
      renderOptResults(res);
    }
  } catch { /* ignore */ }
}

// ========== Result Detail Modal ==========

function openModal(comb: Combination) {
  const bd = $("modal-bd");
  const body = $("modal-body");
  $("modal-title").textContent = fmt(t.ui.modal_rank_title, { rank: comb.rank });

  body.textContent = "";

  // Used modules section
  const modsSection = document.createElement("div");
  modsSection.className = "modal-section";
  const modsTitle = document.createElement("div");
  modsTitle.className = "modal-section-title";
  modsTitle.textContent = t.ui.modal_used_modules;
  modsSection.appendChild(modsTitle);

  const modsWrap = document.createElement("div");
  modsWrap.className = "modal-modules";
  comb.modules.forEach((m) => {
    const modDiv = document.createElement("div");
    modDiv.className = "modal-mod";
    const headDiv = document.createElement("div");
    headDiv.className = "modal-mod-head";
    const origMod = modules.find((om) => om.uuid === m.uuid);
    headDiv.innerHTML = moduleIconHtml(origMod?.config_id ?? null);
    modDiv.appendChild(headDiv);

    const statsDiv = document.createElement("div");
    statsDiv.className = "stats";
    m.stats.forEach((s) => {
      const srow = document.createElement("div");
      srow.className = "srow";
      const iconStr = statIcon(s.part_id);
      if (iconStr) {
        const tmp = document.createElement("span");
        tmp.innerHTML = iconStr;
        if (tmp.firstElementChild) srow.appendChild(tmp.firstElementChild);
      }
      const sname = document.createElement("span");
      sname.className = "sname";
      sname.textContent = statName(s.part_id);
      srow.appendChild(sname);
      const sbarW = document.createElement("div");
      sbarW.className = "sbar-w";
      const sbar = document.createElement("div");
      sbar.className = "sbar";
      sbar.style.width = `${s.value * 10}%`;
      sbarW.appendChild(sbar);
      srow.appendChild(sbarW);
      const sval = document.createElement("span");
      sval.className = "sval";
      sval.textContent = `+${s.value}`;
      srow.appendChild(sval);
      statsDiv.appendChild(srow);
    });
    modDiv.appendChild(statsDiv);
    modsWrap.appendChild(modDiv);
  });
  modsSection.appendChild(modsWrap);
  body.appendChild(modsSection);

  // Stat totals section
  const statTotalsMap = new Map<number, number>();
  comb.modules.forEach((m) => m.stats.forEach((s) => {
    statTotalsMap.set(s.part_id, (statTotalsMap.get(s.part_id) ?? 0) + s.value);
  }));
  const reqIds = new Set(comb.stat_totals.filter((st) => st.is_required).map((st) => st.part_id));
  const desIds = new Set(comb.stat_totals.filter((st) => st.is_desired).map((st) => st.part_id));

  const totalSection = document.createElement("div");
  totalSection.className = "modal-section";
  const totalTitle = document.createElement("div");
  totalTitle.className = "modal-section-title";
  totalTitle.textContent = t.ui.modal_stat_total + " ";
  const totalSpan = document.createElement("span");
  totalSpan.style.cssText = "font-weight:400;font-size:11px;color:var(--tx2);text-transform:none;letter-spacing:0";
  totalSpan.textContent = fmt(t.ui.modal_grand_total, { n: comb.total_plus });
  totalTitle.appendChild(totalSpan);
  totalSection.appendChild(totalTitle);

  const table = document.createElement("table");
  table.className = "modal-table";
  const thead = document.createElement("thead");
  const thRow = document.createElement("tr");
  [t.ui.modal_stat, t.ui.modal_value, t.ui.modal_category].forEach((txt) => {
    const th = document.createElement("th");
    th.textContent = txt;
    thRow.appendChild(th);
  });
  thead.appendChild(thRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  Array.from(statTotalsMap.entries())
    .sort((a, b) => {
      const aP = reqIds.has(a[0]) ? 0 : desIds.has(a[0]) ? 1 : 2;
      const bP = reqIds.has(b[0]) ? 0 : desIds.has(b[0]) ? 1 : 2;
      return aP !== bP ? aP - bP : b[1] - a[1];
    })
    .forEach(([pid, total]) => {
      const tr = document.createElement("tr");
      const tdName = document.createElement("td");
      const iconStr = statIcon(pid);
      if (iconStr) {
        const tmp = document.createElement("span");
        tmp.innerHTML = iconStr;
        if (tmp.firstElementChild) tdName.appendChild(tmp.firstElementChild);
      }
      tdName.appendChild(document.createTextNode(" " + statName(pid)));
      tr.appendChild(tdName);
      const tdVal = document.createElement("td");
      tdVal.className = "val";
      tdVal.textContent = `+${total}`;
      tr.appendChild(tdVal);
      const tdCat = document.createElement("td");
      if (reqIds.has(pid)) {
        const tag = document.createElement("span");
        tag.className = "type-req";
        tag.textContent = t.ui.modal_main;
        tdCat.appendChild(tag);
      } else if (desIds.has(pid)) {
        const tag = document.createElement("span");
        tag.className = "type-des";
        tag.textContent = t.ui.modal_sub;
        tdCat.appendChild(tag);
      }
      tr.appendChild(tdCat);
      tbody.appendChild(tr);
    });
  table.appendChild(tbody);
  totalSection.appendChild(table);
  body.appendChild(totalSection);

  bd.classList.add("on");
}

function closeModal() { $("modal-bd").classList.remove("on"); }

// ========== OCR Confirmation Modal ==========

interface OcrGroup {
  imageUrl: string;
  modules: ModuleInput[];
}

let pendingOcrGroups: OcrGroup[] = [];
let ocrImageZoomStates: { scale: number; translateX: number; translateY: number }[] = [];
let ocrCurrentPage = 0;

function openOcrConfirmationModal(groups: OcrGroup[]) {
  pendingOcrGroups = groups.map((g) => ({
    imageUrl: g.imageUrl,
    modules: g.modules.map((m) => ({ ...m, stats: m.stats.map((s) => ({ ...s })) })),
  }));
  ocrImageZoomStates = groups.map(() => ({ scale: 1, translateX: 0, translateY: 0 }));
  ocrCurrentPage = 0;
  renderOcrModalBody();
  $("ocr-modal-bd").classList.add("on");
}

function closeOcrModal() {
  $("ocr-modal-bd").classList.remove("on");
  pendingOcrGroups = [];
  ocrImageZoomStates = [];
  ocrCurrentPage = 0;
}

function allPendingModules(): ModuleInput[] {
  return pendingOcrGroups.flatMap((g) => g.modules);
}

function updateOcrPager() {
  const total = pendingOcrGroups.length;
  const pager = $("ocr-pager");
  const info = $("ocr-pager-info");
  const prev = $("ocr-prev") as HTMLButtonElement;
  const next = $("ocr-next") as HTMLButtonElement;
  pager.style.display = total <= 1 ? "none" : "";
  info.textContent = `${ocrCurrentPage + 1} / ${total}`;
  prev.disabled = ocrCurrentPage <= 0;
  next.disabled = ocrCurrentPage >= total - 1;
}

function renderOcrModalBody() {
  const body = $("ocr-modal-body");
  const allMods = allPendingModules();

  if (allMods.length === 0) {
    body.textContent = "";
    const emptyDiv = document.createElement("div");
    emptyDiv.className = "ocr-empty";
    emptyDiv.textContent = t.ui.ocr_no_modules;
    body.appendChild(emptyDiv);
    updateOcrPager();
    return;
  }

  if (ocrCurrentPage >= pendingOcrGroups.length) ocrCurrentPage = pendingOcrGroups.length - 1;
  if (ocrCurrentPage < 0) ocrCurrentPage = 0;

  const gi = ocrCurrentPage;
  const group = pendingOcrGroups[gi];

  const listEl = body.querySelector<HTMLElement>(".ocr-group-list");
  const listScrollTop = listEl ? listEl.scrollTop : 0;

  body.textContent = "";

  const section = document.createElement("div");
  section.className = "ocr-group";

  const imgWrap = document.createElement("div");
  imgWrap.className = "ocr-group-img";
  const img = document.createElement("img");
  img.src = group.imageUrl;
  img.alt = fmt(t.ui.ocr_screenshot, { n: gi + 1 });
  imgWrap.appendChild(img);
  section.appendChild(imgWrap);

  const hint = document.createElement("div");
  hint.className = "ocr-group-hint";
  hint.textContent = t.ui.ocr_hint;
  section.appendChild(hint);

  const listWrap = document.createElement("div");
  listWrap.className = "ocr-group-list";

  group.modules.forEach((m, mi) => {
    const comp = configIdToComponents(m.config_id);
    const typeDigit = comp?.typeDigit ?? 1;
    const raritySub = comp?.raritySub ?? 2;

    const row = document.createElement("div");
    row.className = "ocr-row";
    row.dataset.gi = String(gi);
    row.dataset.mi = String(mi);

    const statsHtml = m.stats.map((s, si) => {
      const valueOptions = Array.from({ length: 10 }, (_, i) => i + 1)
        .map((v) => `<option value="${v}"${v === s.value ? " selected" : ""}>${v}</option>`)
        .join("");
      return `<div class="ocr-stat-row">
        <select class="opt-select ocr-stat-name" data-gi="${gi}" data-mi="${mi}" data-si="${si}">${statSelectOptions(s.part_id)}</select>
        <select class="opt-select ocr-stat-value" data-gi="${gi}" data-mi="${mi}" data-si="${si}">${valueOptions}</select>
        <button class="ocr-stat-remove" data-gi="${gi}" data-mi="${mi}" data-si="${si}">&times;</button>
      </div>`;
    }).join("");
    const addStatHtml = m.stats.length < 3
      ? `<button class="addbtn ocr-add-stat" data-gi="${gi}" data-mi="${mi}">${t.ui.add_stat}</button>`
      : "";

    row.innerHTML = `
      <span class="ocr-row-index">${mi + 1}</span>
      <div class="ocr-row-icon" id="ocr-icon-${gi}-${mi}">${moduleIconHtml(m.config_id)}</div>
      <div class="ocr-row-body">
        <div class="ocr-row-fields">
          <label class="form-field">
            <span class="cmd-lbl">${t.ui.type_label}</span>
            <select class="opt-select ocr-type" data-gi="${gi}" data-mi="${mi}">${typeSelectOptions(typeDigit)}</select>
          </label>
          <label class="form-field">
            <span class="cmd-lbl">${t.ui.rarity_sub_label}</span>
            <select class="opt-select ocr-rarity-sub" data-gi="${gi}" data-mi="${mi}">${raritySubSelectOptions(raritySub)}</select>
          </label>
        </div>
        <div class="ocr-row-stats">${statsHtml}${addStatHtml}</div>
      </div>
      <button class="ocr-row-remove" data-gi="${gi}" data-mi="${mi}">&times;</button>`;

    listWrap.appendChild(row);
  });

  const addBtn = document.createElement("button");
  addBtn.className = "addbtn ocr-group-add";
  addBtn.textContent = t.ui.add_module;
  addBtn.dataset.gi = String(gi);
  listWrap.appendChild(addBtn);

  section.appendChild(listWrap);
  body.appendChild(section);

  setupImagePinchZoom(imgWrap, gi);

  body.querySelectorAll<HTMLButtonElement>(".ocr-group-add").forEach((btn) => {
    btn.onclick = () => {
      const g = Number(btn.dataset.gi);
      pendingOcrGroups[g].modules.push({
        uuid: Date.now() + Math.floor(Math.random() * 1000),
        config_id: buildConfigId(1, 2),
        quality: 3,
        stats: [{ part_id: ALL_STAT_IDS[0], value: 1 }],
      });
      renderOcrModalBody();
    };
  });

  const newListEl = body.querySelector<HTMLElement>(".ocr-group-list");
  if (newListEl) newListEl.scrollTop = listScrollTop;

  body.querySelectorAll<HTMLSelectElement>(".ocr-type, .ocr-rarity-sub").forEach((sel) => {
    sel.onchange = () => onOcrFieldChange(Number(sel.dataset.gi), Number(sel.dataset.mi));
  });
  body.querySelectorAll<HTMLSelectElement>(".ocr-stat-name").forEach((sel) => {
    sel.onchange = () => {
      pendingOcrGroups[Number(sel.dataset.gi)].modules[Number(sel.dataset.mi)].stats[Number(sel.dataset.si)].part_id = Number(sel.value);
    };
  });
  body.querySelectorAll<HTMLSelectElement>(".ocr-stat-value").forEach((sel) => {
    sel.onchange = () => {
      pendingOcrGroups[Number(sel.dataset.gi)].modules[Number(sel.dataset.mi)].stats[Number(sel.dataset.si)].value = Number(sel.value);
    };
  });
  body.querySelectorAll<HTMLButtonElement>(".ocr-row-remove").forEach((btn) => {
    btn.onclick = () => {
      const g = Number(btn.dataset.gi);
      const mi = Number(btn.dataset.mi);
      pendingOcrGroups[g].modules.splice(mi, 1);
      if (pendingOcrGroups[g].modules.length === 0) {
        ocrImageZoomStates.splice(g, 1);
        pendingOcrGroups.splice(g, 1);
        if (ocrCurrentPage >= pendingOcrGroups.length && ocrCurrentPage > 0) ocrCurrentPage--;
      }
      renderOcrModalBody();
    };
  });
  body.querySelectorAll<HTMLButtonElement>(".ocr-stat-remove").forEach((btn) => {
    btn.onclick = () => {
      const g = Number(btn.dataset.gi);
      const mi = Number(btn.dataset.mi);
      const si = Number(btn.dataset.si);
      pendingOcrGroups[g].modules[mi].stats.splice(si, 1);
      renderOcrModalBody();
    };
  });
  body.querySelectorAll<HTMLButtonElement>(".ocr-add-stat").forEach((btn) => {
    btn.onclick = () => {
      const g = Number(btn.dataset.gi);
      const mi = Number(btn.dataset.mi);
      pendingOcrGroups[g].modules[mi].stats.push({ part_id: ALL_STAT_IDS[0], value: 1 });
      renderOcrModalBody();
    };
  });

  updateOcrPager();
}

function onOcrFieldChange(gi: number, mi: number) {
  const m = pendingOcrGroups[gi]?.modules[mi];
  const row = document.querySelector(`.ocr-row[data-gi="${gi}"][data-mi="${mi}"]`);
  if (!row || !m) return;
  const typeDigit = Number((row.querySelector(".ocr-type") as HTMLSelectElement).value);
  const raritySub = Number((row.querySelector(".ocr-rarity-sub") as HTMLSelectElement).value);
  m.config_id = buildConfigId(typeDigit, raritySub);
  m.quality = RARITY_SUB_TO_QUALITY[raritySub] ?? null;
  const iconEl = document.getElementById(`ocr-icon-${gi}-${mi}`);
  if (iconEl) iconEl.innerHTML = moduleIconHtml(m.config_id);
}

function registerOcrModules() {
  const all = allPendingModules();
  if (all.length === 0) { closeOcrModal(); return; }
  modules.push(...all);
  saveModulesToStorage();
  renderGrid();
  updateOptRunBtn();
  closeOcrModal();
}

// ========== Edit Module Modal ==========

let editingUuid: number | null = null;
let editStatCount = 1;

function openEditModal(uuid: number) {
  const m = modules.find((mod) => mod.uuid === uuid);
  if (!m) return;
  editingUuid = uuid;
  editStatCount = m.stats.length || 1;
  renderEditModalBody();
  $("edit-modal-bd").classList.add("on");
}

function closeEditModal() {
  $("edit-modal-bd").classList.remove("on");
  editingUuid = null;
}

function renderEditModalBody() {
  const m = modules.find((mod) => mod.uuid === editingUuid);
  if (!m) return;
  const body = $("edit-modal-body");

  const comp = configIdToComponents(m.config_id);
  const typeDigit = comp?.typeDigit ?? 1;
  const raritySub = comp?.raritySub ?? 2;

  const statRows: string[] = [];
  for (let i = 0; i < editStatCount; i++) {
    const curStat = m.stats[i];
    const valueOpts = Array.from({ length: 10 }, (_, v) => v + 1)
      .map((v) => `<option value="${v}"${curStat && v === curStat.value ? " selected" : ""}>\u3000${v}</option>`)
      .join("");
    statRows.push(`<div class="stat-input-group" data-si="${i}">
      <select class="opt-select edit-stat-name">${curStat ? "" : `<option value="">${t.ui.select_placeholder}</option>`}${statSelectOptions(curStat?.part_id)}</select>
      <select class="opt-select edit-stat-value">${valueOpts}</select>
      ${i > 0 ? `<button class="ocr-stat-remove edit-remove-stat" data-si="${i}">&times;</button>` : ""}
    </div>`);
  }

  body.innerHTML = `<div class="manual-form">
    <div class="manual-row">
      <div class="ocr-row-icon" id="edit-icon-preview">${moduleIconHtml(m.config_id)}</div>
      <div class="ocr-row-body">
        <div class="ocr-row-fields">
          <label class="form-field">
            <span class="cmd-lbl">${t.ui.type_label}</span>
            <select class="opt-select" id="edit-type">${typeSelectOptions(typeDigit)}</select>
          </label>
          <label class="form-field">
            <span class="cmd-lbl">${t.ui.rarity_sub_label}</span>
            <select class="opt-select" id="edit-rarity-sub">${raritySubSelectOptions(raritySub)}</select>
          </label>
        </div>
        <div class="manual-stats-section">
          <div class="cmd-lbl">${t.ui.stat_label}</div>
          <div id="edit-stat-rows">${statRows.join("")}</div>
          ${editStatCount < 3 ? `<button class="addbtn" id="edit-add-stat">${t.ui.add_stat}</button>` : ""}
        </div>
      </div>
    </div>
  </div>`;

  const updateIconPreview = () => {
    const td = Number($<HTMLSelectElement>("edit-type").value);
    const rs = Number($<HTMLSelectElement>("edit-rarity-sub").value);
    const preview = document.getElementById("edit-icon-preview");
    if (preview) preview.innerHTML = moduleIconHtml(buildConfigId(td, rs));
  };
  $<HTMLSelectElement>("edit-type").onchange = updateIconPreview;
  $<HTMLSelectElement>("edit-rarity-sub").onchange = updateIconPreview;

  const addBtn = document.getElementById("edit-add-stat");
  if (addBtn) addBtn.onclick = () => {
    syncEditStatsToModule();
    editStatCount++;
    const m2 = modules.find((mod) => mod.uuid === editingUuid);
    if (m2 && m2.stats.length < editStatCount) {
      m2.stats.push({ part_id: ALL_STAT_IDS[0], value: 1 });
    }
    renderEditModalBody();
  };

  body.querySelectorAll<HTMLButtonElement>(".edit-remove-stat").forEach((btn) => {
    btn.onclick = () => {
      syncEditStatsToModule();
      const si = Number(btn.dataset.si);
      const m2 = modules.find((mod) => mod.uuid === editingUuid);
      if (m2) m2.stats.splice(si, 1);
      editStatCount--;
      renderEditModalBody();
    };
  });
}

function syncEditStatsToModule() {
  const m = modules.find((mod) => mod.uuid === editingUuid);
  if (!m) return;
  const rows = document.querySelectorAll<HTMLElement>("#edit-stat-rows .stat-input-group");
  const newStats: StatEntry[] = [];
  rows.forEach((row) => {
    const nameSelect = row.querySelector<HTMLSelectElement>(".edit-stat-name");
    const valueSelect = row.querySelector<HTMLSelectElement>(".edit-stat-value");
    if (!nameSelect || !valueSelect) return;
    const partId = Number(nameSelect.value);
    if (!partId) return;
    newStats.push({ part_id: partId, value: Number(valueSelect.value) });
  });
  m.stats = newStats;
}

function saveEditModule() {
  const m = modules.find((mod) => mod.uuid === editingUuid);
  if (!m) return;
  const typeDigit = Number($<HTMLSelectElement>("edit-type").value);
  const raritySub = Number($<HTMLSelectElement>("edit-rarity-sub").value);
  m.config_id = buildConfigId(typeDigit, raritySub);
  m.quality = RARITY_SUB_TO_QUALITY[raritySub] ?? null;

  const stats: StatEntry[] = [];
  const usedIds = new Set<number>();
  const rows = document.querySelectorAll<HTMLElement>("#edit-stat-rows .stat-input-group");
  for (const row of rows) {
    const nameSelect = row.querySelector<HTMLSelectElement>(".edit-stat-name");
    const valueSelect = row.querySelector<HTMLSelectElement>(".edit-stat-value");
    if (!nameSelect || !valueSelect) continue;
    const partId = Number(nameSelect.value);
    if (!partId) continue;
    if (usedIds.has(partId)) return;
    usedIds.add(partId);
    stats.push({ part_id: partId, value: Number(valueSelect.value) });
  }
  if (stats.length === 0) return;
  m.stats = stats;
  saveModulesToStorage();
  renderGrid();
  updateOptRunBtn();
  closeEditModal();
}

function deleteEditModule() {
  const idx = modules.findIndex((mod) => mod.uuid === editingUuid);
  if (idx < 0) return;
  modules.splice(idx, 1);
  saveModulesToStorage();
  renderGrid();
  updateOptRunBtn();
  closeEditModal();
}

// ========== Manual Input Modal ==========

let manualStatCount = 1;

function openManualInputModal() {
  manualStatCount = 1;
  renderManualModalBody();
  $("manual-modal-bd").classList.add("on");
}

function closeManualModal() {
  $("manual-modal-bd").classList.remove("on");
}

function renderManualModalBody() {
  const body = $("manual-modal-body");

  const statRows: string[] = [];
  for (let i = 0; i < manualStatCount; i++) {
    const valueOpts = Array.from({ length: 10 }, (_, v) => v + 1)
      .map((v) => `<option value="${v}">\u3000${v}</option>`)
      .join("");
    statRows.push(`<div class="stat-input-group" data-si="${i}">
      <select class="opt-select manual-stat-name"><option value="">${t.ui.select_placeholder}</option>${statSelectOptions()}</select>
      <select class="opt-select manual-stat-value">${valueOpts}</select>
      ${i > 0 ? `<button class="ocr-stat-remove manual-remove-stat" data-si="${i}">&times;</button>` : ""}
    </div>`);
  }

  const defaultConfigId = buildConfigId(1, 1);
  body.innerHTML = `<div class="manual-form">
    <div class="manual-row">
      <div class="ocr-row-icon" id="manual-icon-preview">${moduleIconHtml(defaultConfigId)}</div>
      <div class="ocr-row-body">
        <div class="ocr-row-fields">
          <label class="form-field">
            <span class="cmd-lbl">${t.ui.type_label}</span>
            <select class="opt-select" id="manual-type">${typeSelectOptions(1)}</select>
          </label>
          <label class="form-field">
            <span class="cmd-lbl">${t.ui.rarity_sub_label}</span>
            <select class="opt-select" id="manual-rarity-sub">${raritySubSelectOptions(1)}</select>
          </label>
        </div>
        <div class="manual-stats-section">
          <div class="cmd-lbl">${t.ui.stat_label}</div>
          <div id="manual-stat-rows">${statRows.join("")}</div>
          ${manualStatCount < 3 ? `<button class="addbtn" id="manual-add-stat">${t.ui.add_stat}</button>` : ""}
        </div>
      </div>
    </div>
  </div>`;

  const updateManualIconPreview = () => {
    const td = Number($<HTMLSelectElement>("manual-type").value);
    const rs = Number($<HTMLSelectElement>("manual-rarity-sub").value);
    const preview = document.getElementById("manual-icon-preview");
    if (preview) preview.innerHTML = moduleIconHtml(buildConfigId(td, rs));
  };
  $<HTMLSelectElement>("manual-type").onchange = updateManualIconPreview;
  $<HTMLSelectElement>("manual-rarity-sub").onchange = updateManualIconPreview;

  const addBtn = document.getElementById("manual-add-stat");
  if (addBtn) addBtn.onclick = () => { manualStatCount++; renderManualModalBody(); };

  body.querySelectorAll<HTMLButtonElement>(".manual-remove-stat").forEach((btn) => {
    btn.onclick = () => { manualStatCount--; renderManualModalBody(); };
  });
}

function addManualModule() {
  const typeDigit = Number($<HTMLSelectElement>("manual-type").value);
  const raritySub = Number($<HTMLSelectElement>("manual-rarity-sub").value);
  const configId = buildConfigId(typeDigit, raritySub);
  const quality = RARITY_SUB_TO_QUALITY[raritySub] ?? null;

  const stats: StatEntry[] = [];
  const rows = document.querySelectorAll<HTMLElement>(".stat-input-group");
  const usedIds = new Set<number>();

  for (const row of rows) {
    const nameSelect = row.querySelector<HTMLSelectElement>(".manual-stat-name");
    const valueSelect = row.querySelector<HTMLSelectElement>(".manual-stat-value");
    if (!nameSelect || !valueSelect) continue;
    const partId = Number(nameSelect.value);
    if (!partId) continue;
    if (usedIds.has(partId)) {
      showToast(t.ui.stat_duplicate, "error");
      return;
    }
    usedIds.add(partId);
    stats.push({ part_id: partId, value: Number(valueSelect.value) });
  }

  if (stats.length === 0) {
    showToast(t.ui.stat_required, "error");
    return;
  }

  const m: ModuleInput = {
    uuid: Date.now() + Math.floor(Math.random() * 1000),
    config_id: configId,
    quality,
    stats,
  };

  modules.push(m);
  saveModulesToStorage();
  renderGrid();
  updateOptRunBtn();
  showToast(t.ui.module_added, "success");
  manualStatCount = 1;
  renderManualModalBody();
}

// ========== Screenshot Import ==========

function createThumbnailDataUrl(img: HTMLImageElement, maxWidth = 1920): string {
  const scale = Math.min(1, maxWidth / img.naturalWidth);
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  const dataUrl = c.toDataURL("image/webp", 0.8);
  c.width = 0;
  c.height = 0;
  return dataUrl;
}

function importScreenshot() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;
  input.addEventListener("change", async () => {
    const files = input.files;
    if (!files || files.length === 0) return;

    const btn = $<HTMLButtonElement>("screenshot-btn");
    btn.classList.add("loading");
    btn.textContent = t.ui.ocr_reading;
    const overlay = createLoadingOverlay();
    const appEl = document.querySelector(".app")!;
    const statusbar = appEl.querySelector(".statusbar")!;
    appEl.insertBefore(overlay, statusbar);

    const groups: OcrGroup[] = [];
    const progress = $("sb-progress");
    const total = files.length;
    progress.textContent = fmt(t.ui.ocr_progress, { current: 0, total });
    progress.style.display = "";

    const { createWorker } = await import("tesseract.js");
    const ocrWorker = await createWorker("eng");
    await ocrWorker.setParameters({
      tessedit_char_whitelist: "+0123456789",
      tessedit_pageseg_mode: "7" as any,
    });

    try {
      for (let fi = 0; fi < files.length; fi++) {
        const file = files[fi];
        const imageUrl = URL.createObjectURL(file);
        const img = new Image();
        img.src = imageUrl;
        await new Promise((resolve) => (img.onload = resolve));
        try {
          const detected = await processScreenshot(img, undefined, ocrWorker);
          if (detected.length > 0) {
            const thumbnailUrl = createThumbnailDataUrl(img);
            groups.push({ imageUrl: thumbnailUrl, modules: detected });
          }
        } catch {
          throw new Error(t.ui.ocr_failed);
        } finally {
          URL.revokeObjectURL(imageUrl);
          img.src = "";
        }
        progress.textContent = fmt(t.ui.ocr_progress, { current: fi + 1, total });
      }

      overlay.remove();
      btn.classList.remove("loading");
      btn.textContent = t.ui.btn_screenshot;
      progress.style.display = "none";
      if (groups.length === 0) {
        showToast(t.ui.ocr_no_detect, "error");
      } else {
        openOcrConfirmationModal(groups);
      }
    } catch (err) {
      overlay.remove();
      btn.classList.remove("loading");
      btn.textContent = t.ui.btn_screenshot;
      progress.style.display = "none";
      showToast(err instanceof Error ? err.message : t.ui.ocr_failed, "error");
    } finally {
      await ocrWorker.terminate();
    }
  });
  input.click();
}

// ========== Loading overlay ==========

function createLoadingOverlay(): HTMLElement {
  const overlay = document.createElement("div");
  overlay.className = "opt-loading-overlay";
  overlay.innerHTML = `<div class="loader"><ul class="hexagon-container">
    <li class="hexagon hex_1"></li><li class="hexagon hex_2"></li>
    <li class="hexagon hex_3"></li><li class="hexagon hex_4"></li>
    <li class="hexagon hex_5"></li><li class="hexagon hex_6"></li>
    <li class="hexagon hex_7"></li></ul></div>`;
  return overlay;
}

// ========== Clear ==========

let clearPending = false;

function clearModules() {
  if (modules.length === 0) return;
  if (!clearPending) {
    clearPending = true;
    $("clear-btn").textContent = t.ui.clear_confirm;
    $("clear-btn").classList.add("has-items");
    setTimeout(() => {
      clearPending = false;
      $("clear-btn").textContent = t.ui.btn_clear;
      $("clear-btn").classList.remove("has-items");
    }, 3000);
    return;
  }
  clearPending = false;
  modules = [];
  localStorage.removeItem("modules");
  $("clear-btn").textContent = t.ui.btn_clear;
  $("clear-btn").classList.remove("has-items");
  renderGrid();
  updateOptRunBtn();
  showToast(t.ui.clear_done, "success");
}

// ========== Toast ==========

function showToast(msg: string, type: "success" | "error" = "success") {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.style.display = "block";
  setTimeout(() => (el.style.display = "none"), 4000);
}

// ========== Sidebar ==========

function openSidebar() {
  const current = getSavedLang();
  const radio = document.querySelector<HTMLInputElement>(`#lang-options input[value="${current}"]`);
  if (radio) radio.checked = true;
  $("sidebar").classList.add("on");
  $("sidebar-bd").classList.add("on");
}

function closeSidebar() {
  $("sidebar").classList.remove("on");
  $("sidebar-bd").classList.remove("on");
}

function switchLanguage(code: string) {
  saveLang(code);
  applyI18n();
  renderGrid();
  renderSChips();
  renderPatternSelect();
  updateFilterBtnLabel();
  updateOptBtnLabel("req");
  updateOptBtnLabel("des");
  updateOptBtnLabel("excl");
  // Re-render opt results if visible
  const resultsEl = $("opt-results");
  if (resultsEl.style.display !== "none") {
    restoreOptResults();
  }
  // Update opt-empty
  const emptyEl = $("opt-empty");
  if (emptyEl.style.display !== "none") {
    emptyEl.textContent = "";
    const icon = document.createElement("div");
    icon.style.cssText = "font-size:28px;opacity:0.22";
    icon.textContent = "\u25C8";
    const msg = document.createElement("div");
    msg.textContent = t.ui.opt_empty;
    emptyEl.appendChild(icon);
    emptyEl.appendChild(msg);
  }
  document.documentElement.lang = code === "ko" ? "ko" : code === "en" ? "en" : "ja";
}

// ========== Init ==========

document.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false } as any);
document.addEventListener("gesturechange", (e) => e.preventDefault(), { passive: false } as any);
document.addEventListener("gestureend", (e) => e.preventDefault(), { passive: false } as any);
document.addEventListener("dblclick", (e) => e.preventDefault());

let lastTouchEnd = 0;
document.addEventListener("touchend", (e) => {
  const now = Date.now();
  if (now - lastTouchEnd <= 300) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });

document.addEventListener("touchmove", (e) => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

// ========== Image pinch zoom ==========

function setupImagePinchZoom(container: HTMLElement, gi: number) {
  const img = container.querySelector("img");
  if (!img) return;

  const saved = ocrImageZoomStates[gi];
  let scale = saved?.scale ?? 1;
  let translateX = saved?.translateX ?? 0;
  let translateY = saved?.translateY ?? 0;
  if (scale !== 1 || translateX !== 0 || translateY !== 0) {
    img.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  }

  let startDistance = 0;
  let startScale = 1;
  let startMidX = 0;
  let startMidY = 0;
  let startTranslateX = 0;
  let startTranslateY = 0;
  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;
  let panStartTranslateX = 0;
  let panStartTranslateY = 0;

  function applyTransform() {
    img!.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    if (ocrImageZoomStates[gi]) {
      ocrImageZoomStates[gi] = { scale, translateX, translateY };
    }
  }

  function clampTranslate() {
    if (scale <= 1) { translateX = 0; translateY = 0; return; }
    const rect = container.getBoundingClientRect();
    const imgW = img!.naturalWidth * (rect.width / img!.naturalWidth) * scale;
    const imgH = img!.naturalHeight * (rect.width / img!.naturalWidth) * scale;
    translateX = Math.min(0, Math.max(rect.width - imgW, translateX));
    translateY = Math.min(0, Math.max(rect.height - imgH, translateY));
  }

  function getTouchDistance(t1: Touch, t2: Touch) {
    return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
  }

  function getTouchMid(t1: Touch, t2: Touch, rect: DOMRect) {
    return { x: (t1.clientX + t2.clientX) / 2 - rect.left, y: (t1.clientY + t2.clientY) / 2 - rect.top };
  }

  container.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      e.preventDefault(); e.stopPropagation(); isPanning = false;
      startDistance = getTouchDistance(e.touches[0], e.touches[1]);
      startScale = scale;
      const rect = container.getBoundingClientRect();
      const mid = getTouchMid(e.touches[0], e.touches[1], rect);
      startMidX = mid.x; startMidY = mid.y;
      startTranslateX = translateX; startTranslateY = translateY;
    } else if (e.touches.length === 1 && scale > 1) {
      isPanning = true;
      panStartX = e.touches[0].clientX; panStartY = e.touches[0].clientY;
      panStartTranslateX = translateX; panStartTranslateY = translateY;
    }
  }, { passive: false });

  container.addEventListener("touchmove", (e) => {
    if (e.touches.length === 2) {
      e.preventDefault(); e.stopPropagation();
      const currentDistance = getTouchDistance(e.touches[0], e.touches[1]);
      const newScale = Math.min(5, Math.max(1, startScale * (currentDistance / startDistance)));
      const rect = container.getBoundingClientRect();
      const mid = getTouchMid(e.touches[0], e.touches[1], rect);
      const scaleRatio = newScale / startScale;
      translateX = mid.x - (startMidX - startTranslateX) * scaleRatio;
      translateY = mid.y - (startMidY - startTranslateY) * scaleRatio;
      scale = newScale;
      clampTranslate(); applyTransform();
    } else if (e.touches.length === 1 && isPanning && scale > 1) {
      e.preventDefault(); e.stopPropagation();
      translateX = panStartTranslateX + (e.touches[0].clientX - panStartX);
      translateY = panStartTranslateY + (e.touches[0].clientY - panStartY);
      clampTranslate(); applyTransform();
    }
  }, { passive: false });

  container.addEventListener("touchend", (e) => {
    if (e.touches.length === 0) {
      isPanning = false;
      if (scale < 1.05) { scale = 1; translateX = 0; translateY = 0; applyTransform(); }
    }
  });

  let lastTap = 0;
  container.addEventListener("touchend", (e) => {
    if (e.touches.length !== 0) return;
    const now = Date.now();
    if (now - lastTap < 300) { scale = 1; translateX = 0; translateY = 0; applyTransform(); }
    lastTap = now;
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initLang();
  applyI18n();
  document.documentElement.lang = getSavedLang() === "ko" ? "ko" : getSavedLang() === "en" ? "en" : "ja";

  loadModulesFromStorage();

  // Tabs
  document.querySelectorAll<HTMLElement>(".tab").forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((x) => x.classList.remove("active"));
      tab.classList.add("active");
      $("panel-" + tab.dataset.tab!).classList.add("active");
    };
  });

  $("filter-btn").onclick = (e) => openFilterMultiFly(e.currentTarget as HTMLElement);

  const modeBtn = $("filter-mode");
  modeBtn.onclick = () => {
    filterMode = filterMode === "and" ? "or" : "and";
    modeBtn.textContent = filterMode.toUpperCase();
    modeBtn.classList.toggle("or", filterMode === "or");
    renderGrid();
  };

  $("add-s").onclick = (e) => {
    const ex = new Set(sortKeys.map((s) => s.k));
    const extraItems: { label: string; val: string; disabled: boolean }[] = [
      { label: t.ui.sort_rarity, val: "rarity", disabled: ex.has("rarity") },
      { label: t.ui.sort_total, val: "total", disabled: ex.has("total") },
    ];
    const statItems = ALL_STAT_IDS.map((id) => ({ label: statName(id), val: String(id), disabled: ex.has(String(id)) }));
    openFly("fly-s", e.currentTarget as HTMLElement, [...extraItems, ...statItems], (it) => {
      sortKeys.push({ k: it.val, d: 1 });
      renderSChips();
      renderGrid();
    });
  };

  $("bd").onclick = closeFly;

  $("opt-btn-req").onclick = (e) => openOptMultiFly(e.currentTarget as HTMLElement, "req");
  $("opt-btn-des").onclick = (e) => openOptMultiFly(e.currentTarget as HTMLElement, "des");
  $("opt-btn-excl").onclick = (e) => openOptMultiFly(e.currentTarget as HTMLElement, "excl");
  $("opt-quality").onchange = () => { minQuality = Number($<HTMLSelectElement>("opt-quality").value); saveOptState(); };
  $("opt-run").onclick = () => runOptimize();

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
    items.forEach((text) => { const li = document.createElement("li"); li.textContent = text; ul.appendChild(li); });
    body.appendChild(ul);
    const note = document.createElement("p");
    note.textContent = t.ui.speed_info_note;
    note.style.cssText = "margin:0;font-size:12px;color:#e8a735;line-height:1.6";
    body.appendChild(note);
    $("speed-info-bd").classList.add("on");
  };
  $("speed-info-close").onclick = () => $("speed-info-bd").classList.remove("on");
  $("speed-info-bd").onclick = (e) => { if (e.target === $("speed-info-bd")) $("speed-info-bd").classList.remove("on"); };

  renderPatternSelect();
  $("pattern-select").onchange = () => updatePatternButtons();
  $("pattern-load").onclick = () => {
    const idx = Number($<HTMLSelectElement>("pattern-select").value);
    if (!isNaN(idx) && idx >= 0) loadPattern(idx);
  };
  const patsaveBd = $("patsave-modal-bd");
  const patsaveInput = $<HTMLInputElement>("patsave-name");
  const openPatsaveModal = () => { patsaveInput.value = ""; patsaveBd.classList.add("on"); setTimeout(() => patsaveInput.focus(), 50); };
  const closePatsaveModal = () => { patsaveBd.classList.remove("on"); };
  const confirmPatsave = () => {
    const name = patsaveInput.value.trim();
    if (!name) return;
    closePatsaveModal();
    const quality = Number($<HTMLSelectElement>("opt-quality").value);
    const patterns = getPatterns();
    const existing = patterns.findIndex((p) => p.name === name);
    const entry: OptPattern = { name, required: [...optRequired], desired: [...optDesired], excluded: [...optExcluded], quality };
    if (existing >= 0) patterns[existing] = entry;
    else patterns.push(entry);
    savePatterns(patterns);
    renderPatternSelect();
    $<HTMLSelectElement>("pattern-select").value = String(existing >= 0 ? existing : patterns.length - 1);
  };
  $("pattern-save").onclick = openPatsaveModal;
  $("patsave-modal-close").onclick = closePatsaveModal;
  $("patsave-cancel").onclick = closePatsaveModal;
  $("patsave-ok").onclick = confirmPatsave;
  patsaveInput.addEventListener("keydown", (e) => { if (e.key === "Enter") confirmPatsave(); });
  patsaveBd.addEventListener("click", (e) => { if (e.target === patsaveBd) closePatsaveModal(); });

  const patdelBd = $("patdel-modal-bd");
  const closePatdelModal = () => { patdelBd.classList.remove("on"); };
  let patdelIdx = -1;
  $("pattern-delete").onclick = () => {
    const sel = $<HTMLSelectElement>("pattern-select");
    const idx = Number(sel.value);
    if (sel.value === "" || isNaN(idx) || idx < 0) return;
    const patterns = getPatterns();
    const p = patterns[idx];
    if (!p) return;
    patdelIdx = idx;
    $("patdel-msg").textContent = fmt(t.ui.pattern_delete_confirm, { name: p.name });
    patdelBd.classList.add("on");
  };
  $("patdel-ok").onclick = () => {
    closePatdelModal();
    const patterns = getPatterns();
    if (patdelIdx >= 0 && patdelIdx < patterns.length) {
      patterns.splice(patdelIdx, 1);
      savePatterns(patterns);
      renderPatternSelect();
    }
    patdelIdx = -1;
  };
  $("patdel-modal-close").onclick = closePatdelModal;
  $("patdel-cancel").onclick = closePatdelModal;
  patdelBd.addEventListener("click", (e) => { if (e.target === patdelBd) closePatdelModal(); });

  $("modal-close").onclick = closeModal;
  $("modal-bd").onclick = (e) => { if (e.target === $("modal-bd")) closeModal(); };

  $("ocr-register").onclick = registerOcrModules;
  $("ocr-cancel").onclick = closeOcrModal;
  $("ocr-modal-close").onclick = closeOcrModal;
  $("ocr-prev").onclick = () => { ocrCurrentPage--; renderOcrModalBody(); };
  $("ocr-next").onclick = () => { ocrCurrentPage++; renderOcrModalBody(); };

  $("manual-btn").onclick = () => openManualInputModal();
  $("manual-modal-close").onclick = closeManualModal;
  $("manual-cancel").onclick = closeManualModal;
  $("manual-add").onclick = addManualModule;
  $("manual-modal-bd").onclick = (e) => { if (e.target === $("manual-modal-bd")) closeManualModal(); };

  $("edit-modal-close").onclick = closeEditModal;
  $("edit-cancel").onclick = closeEditModal;
  $("edit-save").onclick = saveEditModule;
  $("edit-delete").onclick = deleteEditModule;
  $("edit-modal-bd").onclick = (e) => { if (e.target === $("edit-modal-bd")) closeEditModal(); };

  $("screenshot-btn").onclick = () => importScreenshot();
  $("clear-btn").onclick = () => clearModules();

  // Sidebar
  $("hamburger-btn").onclick = () => openSidebar();
  $("sidebar-close").onclick = () => closeSidebar();
  $("sidebar-bd").onclick = () => closeSidebar();
  document.querySelectorAll<HTMLInputElement>('#lang-options input[name="lang"]').forEach((radio) => {
    radio.onchange = () => { if (radio.checked) switchLanguage(radio.value); };
  });

  restoreOptState();
  restoreOptResults();
  updateOptBtnLabel("req");
  updateOptBtnLabel("des");
  updateOptBtnLabel("excl");
  updateOptRunBtn();
  updateFilterBtnLabel();
  renderSChips();
  renderGrid();
});
