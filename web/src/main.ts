import {
  STAT_ICONS, ALL_STAT_IDS, configIdToIcon,
} from "@shared/stats";
import type {
  Combination, CombinationModule, ModuleInput, OptimizeRequest,
  OptimizeResponse, StatEntry, StatTotal,
} from "@shared/types";
import { processScreenshot } from "./ocr";
import {
  saveOcrGroups, loadOcrGroups, deleteOcrGroups, hasOcrGroups,
  type OcrGroup,
} from "./ocr-store";
import {
  t, fmt, statName, applyI18n, initLang, saveLang, getSavedLang,
  JA, migrateStatNamesToIds,
} from "./i18n";

// --- Helpers ---
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let activeFlyout: HTMLElement | null = null;
let activeFlyAnchor: HTMLElement | null = null;

function positionFlyout(fl: HTMLElement, anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  const menuH = fl.scrollHeight;
  const flyW = fl.offsetWidth || 176;
  const spaceBelow = window.innerHeight - rect.bottom - 4;
  const spaceAbove = rect.top - 4;

  let left = rect.left;
  if (left + flyW > window.innerWidth - 8) left = window.innerWidth - flyW - 8;
  if (left < 8) left = 8;
  fl.style.left = left + "px";
  fl.style.minWidth = rect.width + "px";

  if (spaceBelow >= menuH || spaceBelow >= spaceAbove) {
    fl.style.top = rect.bottom + 2 + "px";
    fl.style.bottom = "";
    fl.style.maxHeight = Math.min(240, spaceBelow) + "px";
  } else {
    fl.style.top = "";
    fl.style.bottom = (window.innerHeight - rect.top + 2) + "px";
    fl.style.maxHeight = Math.min(240, spaceAbove) + "px";
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
let optMinRequired: number[] = [];
let optMinDesired: number[] = [];
let minQuality = 3;

// --- Multi Web Worker ---
const numWorkers = Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) * 0.9));
const workers: Worker[] = [];
for (let i = 0; i < numWorkers; i++) {
  workers.push(new Worker(new URL("./wasm-worker.ts", import.meta.url), { type: "module" }));
}
// WASMモジュールを1回だけコンパイルし、全Workerに転送
WebAssembly.compileStreaming(fetch(new URL("../pkg/star_optimizer_wasm_bg.wasm", import.meta.url)))
  .then((mod) => { for (const w of workers) w.postMessage({ type: "init", module: mod }); });

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

function statDropdownHtml(
  className: string,
  selectedId?: number,
  dataAttrs?: Record<string, string>,
  placeholder?: string,
): string {
  const dataStr = dataAttrs
    ? Object.entries(dataAttrs).map(([k, v]) => `data-${k}="${v}"`).join(" ")
    : "";
  const hasSelection = selectedId != null && selectedId !== 0;
  const selectedIcon = hasSelection ? STAT_ICONS[selectedId] : undefined;
  const selectedName = hasSelection ? statName(selectedId) : (placeholder || "");

  const triggerContent = hasSelection
    ? `<img class="sicon" src="/icons/${selectedIcon}" alt=""><span>${selectedName}</span>`
    : `<span class="stat-dd-placeholder">${placeholder || ""}</span>`;

  const placeholderItem = placeholder
    ? `<div class="stat-dd-item${!hasSelection ? " selected" : ""}" data-value="">${placeholder}</div>`
    : "";
  const items = ALL_STAT_IDS.map((id) => {
    const icon = STAT_ICONS[id];
    const name = statName(id);
    return `<div class="stat-dd-item${id === selectedId ? " selected" : ""}" data-value="${id}">
      <img class="sicon" src="/icons/${icon}" alt=""><span>${name}</span>
    </div>`;
  }).join("");

  return `<div class="stat-dd ${className}" ${dataStr} data-value="${hasSelection ? selectedId : ""}">
    <button type="button" class="stat-dd-trigger">${triggerContent}</button>
    <div class="stat-dd-menu">${placeholderItem}${items}</div>
  </div>`;
}

let activeStatDdMenu: HTMLElement | null = null;
let activeStatDd: HTMLElement | null = null;

function positionStatDdMenu(dd: HTMLElement, menu: HTMLElement) {
  const rect = dd.getBoundingClientRect();
  const menuH = menu.scrollHeight;
  const spaceBelow = window.innerHeight - rect.bottom - 4;
  const spaceAbove = rect.top - 4;

  menu.style.left = rect.left + "px";
  menu.style.minWidth = rect.width + "px";

  if (spaceBelow >= menuH || spaceBelow >= spaceAbove) {
    menu.style.top = rect.bottom + 2 + "px";
    menu.style.bottom = "";
    menu.style.maxHeight = Math.min(240, spaceBelow) + "px";
  } else {
    menu.style.top = "";
    menu.style.bottom = (window.innerHeight - rect.top + 2) + "px";
    menu.style.maxHeight = Math.min(240, spaceAbove) + "px";
  }
}

function closeAllStatDropdowns() {
  if (activeStatDdMenu) {
    activeStatDdMenu.remove();
    activeStatDdMenu = null;
  }
  if (activeStatDd) {
    activeStatDd.classList.remove("open");
    activeStatDd = null;
  }
}

function initStatDropdowns(container: HTMLElement) {
  container.querySelectorAll<HTMLElement>(".stat-dd").forEach((dd) => {
    const trigger = dd.querySelector<HTMLButtonElement>(".stat-dd-trigger")!;
    const menuTemplate = dd.querySelector<HTMLElement>(".stat-dd-menu")!;
    menuTemplate.remove();

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = activeStatDd === dd;
      closeAllStatDropdowns();
      if (wasOpen) return;

      const menu = menuTemplate.cloneNode(true) as HTMLElement;
      document.body.appendChild(menu);
      menu.classList.add("stat-dd-menu-portal");
      dd.classList.add("open");
      activeStatDdMenu = menu;
      activeStatDd = dd;

      positionStatDdMenu(dd, menu);

      const sel = menu.querySelector<HTMLElement>(".stat-dd-item.selected");
      if (sel) sel.scrollIntoView({ block: "nearest" });

      menu.querySelectorAll<HTMLElement>(".stat-dd-item").forEach((item) => {
        item.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const val = item.dataset.value || "";
          dd.dataset.value = val;

          menuTemplate.querySelectorAll(".stat-dd-item.selected").forEach((s) => s.classList.remove("selected"));
          const origItem = menuTemplate.querySelector<HTMLElement>(`.stat-dd-item[data-value="${val}"]`);
          if (origItem) origItem.classList.add("selected");

          if (val) {
            const id = Number(val);
            const icon = STAT_ICONS[id];
            trigger.innerHTML = `<img class="sicon" src="/icons/${icon}" alt=""><span>${statName(id)}</span>`;
          } else {
            trigger.innerHTML = `<span class="stat-dd-placeholder">${trigger.textContent || ""}</span>`;
          }
          closeAllStatDropdowns();
          dd.dispatchEvent(new Event("change", { bubbles: true }));
        });
      });
    });
  });
}

document.addEventListener("click", (e) => {
  closeAllStatDropdowns();
  if (activeFlyout && !activeFlyout.contains(e.target as Node) &&
      (!activeFlyAnchor || !activeFlyAnchor.contains(e.target as Node))) {
    closeFly();
  }
  if (detailFlyActive) {
    const fl = $("fly-detail");
    if (!fl.contains(e.target as Node) &&
        (!detailFlyAnchor || !detailFlyAnchor.contains(e.target as Node))) {
      closeDetailFly();
    }
  }
});
window.addEventListener("resize", () => {
  closeAllStatDropdowns();
  closeFly();
  closeDetailFly();
});
document.addEventListener("scroll", (e) => {
  if (activeStatDdMenu && !activeStatDdMenu.contains(e.target as Node)) {
    closeAllStatDropdowns();
  }
  if (activeFlyout && !activeFlyout.contains(e.target as Node)) {
    closeFly();
  }
  if (detailFlyActive) {
    const fl = $("fly-detail");
    if (!fl.contains(e.target as Node)) {
      closeDetailFly();
    }
  }
}, true);

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
  items: { label: string; checked: boolean; iconSrc?: string }[],
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
    el.appendChild(cb);
    if (item.iconSrc) {
      const img = document.createElement("img");
      img.className = "sicon";
      img.src = item.iconSrc;
      img.alt = "";
      el.appendChild(img);
    }
    const span = document.createElement("span");
    span.textContent = item.label;
    el.appendChild(span);
    fl.appendChild(el);
  });
}

const RARITY_FILTER_VALUES: Rarity[] = ["gold", "purple", "blue"];

function openFilterMultiFly(anchor: HTMLElement) {
  const fl = $("fly-filter");
  if (activeFlyout === fl) { closeFly(); return; }
  closeFly();
  fl.textContent = "";
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
    ALL_STAT_IDS.map((id) => {
      const icon = STAT_ICONS[id];
      return { label: statName(id), checked: filterStats.includes(id), iconSrc: icon ? `/icons/${icon}` : undefined };
    }),
    (i, checked) => {
      const val = ALL_STAT_IDS[i];
      if (checked) filterStats.push(val);
      else { const idx = filterStats.indexOf(val); if (idx >= 0) filterStats.splice(idx, 1); }
      refresh();
    },
  );

  fl.classList.add("on");
  positionFlyout(fl, anchor);
  activeFlyout = fl;
  activeFlyAnchor = anchor;
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
  items: { label: string; val: string; disabled: boolean; iconSrc?: string }[],
  onPick: (item: { label: string; val: string }) => void,
) {
  closeFly();
  const fl = $(flyId);
  fl.textContent = "";
  items.forEach((it) => {
    const el = document.createElement("div");
    el.className = "fitem" + (it.disabled ? " dim" : "");
    if (it.iconSrc) {
      const img = document.createElement("img");
      img.className = "sicon";
      img.src = it.iconSrc;
      img.alt = "";
      el.appendChild(img);
      const span = document.createElement("span");
      span.textContent = it.label;
      el.appendChild(span);
    } else {
      el.textContent = it.label;
    }
    if (!it.disabled) el.onclick = () => { closeFly(); onPick(it); };
    fl.appendChild(el);
  });
  fl.classList.add("on");
  positionFlyout(fl, anchor);
  activeFlyout = fl;
  activeFlyAnchor = anchor;
}

function closeFly() {
  if (activeFlyout) {
    activeFlyout.classList.remove("on");
    activeFlyout.style.top = "";
    activeFlyout.style.bottom = "";
    activeFlyout.style.maxHeight = "";
    activeFlyout.style.minWidth = "";
    activeFlyout = null;
    activeFlyAnchor = null;
  }
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
  min_required?: number[];
  min_desired?: number[];
}

function saveOptState() {
  const quality = Number($<HTMLSelectElement>("opt-quality").value);
  localStorage.setItem(OPT_STATE_KEY, JSON.stringify({
    required: optRequired, desired: optDesired, excluded: optExcluded, quality,
    min_required: optMinRequired, min_desired: optMinDesired,
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
    if (Array.isArray(s.min_required)) optMinRequired = (s.min_required as number[]).filter((id) => ALL_STAT_IDS.includes(id) && optRequired.includes(id));
    if (Array.isArray(s.min_desired)) optMinDesired = (s.min_desired as number[]).filter((id) => ALL_STAT_IDS.includes(id) && optDesired.includes(id));
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
  optMinRequired = Array.isArray(p.min_required) ? p.min_required.filter((id) => ALL_STAT_IDS.includes(id) && optRequired.includes(id)) : [];
  optMinDesired = Array.isArray(p.min_desired) ? p.min_desired.filter((id) => ALL_STAT_IDS.includes(id) && optDesired.includes(id)) : [];
  if (p.quality) $<HTMLSelectElement>("opt-quality").value = String(p.quality);
  updateOptBtnLabel("req");
  updateOptBtnLabel("des");
  updateOptBtnLabel("excl");
  updateOptRunBtn();
  saveOptState();
}

function updateOptBtnLabel(category: "req" | "des" | "excl") {
  const btnId = { req: "opt-btn-req", des: "opt-btn-des", excl: "opt-btn-excl" }[category];
  const btn = document.getElementById(btnId);
  if (!btn) return;
  const items = { req: optRequired, des: optDesired, excl: optExcluded }[category];
  btn.textContent = items.length > 0 ? fmt(t.ui.filter_count, { count: items.length }) : t.ui.filter_none;
  btn.classList.toggle("has-items", items.length > 0);
}

function openOptMultiFly(anchor: HTMLElement, category: "req" | "des" | "excl") {
  const fl = $("fly-multi");
  if (activeFlyout === fl && fl.dataset.category === category) { closeFly(); return; }
  closeFly();
  fl.dataset.category = category;
  const current = { req: optRequired, des: optDesired, excl: optExcluded }[category];
  const others = (["req", "des", "excl"] as const)
    .filter((k) => k !== category)
    .flatMap((k) => ({ req: optRequired, des: optDesired, excl: optExcluded }[k]));
  const otherSet = new Set(others);

  fl.textContent = "";
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
    el.appendChild(cb);
    const icon = STAT_ICONS[id];
    if (icon) {
      const img = document.createElement("img");
      img.className = "sicon";
      img.src = `/icons/${icon}`;
      img.alt = "";
      el.appendChild(img);
    }
    const span = document.createElement("span");
    span.textContent = statName(id);
    el.appendChild(span);
    fl.appendChild(el);
  });

  fl.classList.add("on");
  positionFlyout(fl, anchor);
  activeFlyout = fl;
  activeFlyAnchor = anchor;
}

function updateOptRunBtn() {
  $<HTMLButtonElement>("opt-run").disabled = optRequired.length === 0 || modules.length < 4;
}

// --- 詳細設定モーダル ---

function updateDetailBtnLabels() {
  const setBtn = (id: string, items: number[]) => {
    const btn = $(id);
    btn.textContent = items.length > 0 ? fmt(t.ui.filter_count, { count: items.length }) : t.ui.filter_none;
    btn.classList.toggle("has-items", items.length > 0);
  };
  setBtn("detail-btn-req", optRequired);
  setBtn("detail-btn-des", optDesired);
  setBtn("detail-btn-excl", optExcluded);
  setBtn("detail-btn-min-req", optMinRequired);
  setBtn("detail-btn-min-des", optMinDesired);
}

let detailFlyActive = false;
let detailFlyCategory = "";
let detailFlyAnchor: HTMLElement | null = null;

function closeDetailFly() {
  const fl = $("fly-detail");
  fl.classList.remove("on");
  fl.style.top = "";
  fl.style.bottom = "";
  fl.style.maxHeight = "";
  detailFlyActive = false;
  detailFlyCategory = "";
  detailFlyAnchor = null;
}

function openDetailModal() {
  closeFly();
  updateDetailBtnLabels();
  $("detail-modal-bd").classList.add("on");
}

function closeDetailModal() {
  closeDetailFly();
  $("detail-modal-bd").classList.remove("on");
  updateOptBtnLabel("req");
  updateOptRunBtn();
  saveOptState();
}

function openDetailFly(
  anchor: HTMLElement,
  category: "req" | "des" | "excl" | "min-req" | "min-des",
) {
  const fl = $("fly-detail");
  if (detailFlyActive && detailFlyCategory === category) {
    closeDetailFly();
    return;
  }
  closeDetailFly();
  detailFlyCategory = category;
  detailFlyActive = true;
  detailFlyAnchor = anchor;
  fl.textContent = "";

  if (category === "min-req" || category === "min-des") {
    let sourceArr: number[];
    const minArr = category === "min-req" ? optMinRequired : optMinDesired;

    if (category === "min-req") {
      sourceArr = optRequired;
    } else {
      // +16以上: メインステータス＋サブステータスから、+20選択済みを除外
      const minReqSet = new Set(optMinRequired);
      const seen = new Set<number>();
      sourceArr = [...optRequired, ...optDesired].filter((pid) => {
        if (seen.has(pid) || minReqSet.has(pid)) return false;
        seen.add(pid);
        return true;
      });
    }

    if (sourceArr.length === 0) {
      const empty = document.createElement("div");
      empty.className = "fitem";
      empty.style.opacity = "0.5";
      empty.textContent = t.ui.filter_none;
      fl.appendChild(empty);
    } else {
      sourceArr.forEach((pid) => {
        const isSelected = minArr.includes(pid);
        const el = document.createElement("label");
        el.className = "fitem-check";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = isSelected;
        cb.onchange = () => {
          if (cb.checked) {
            if (!minArr.includes(pid)) minArr.push(pid);
            // +20に追加時、+16から除去
            if (category === "min-req") {
              const idx16 = optMinDesired.indexOf(pid);
              if (idx16 >= 0) optMinDesired.splice(idx16, 1);
            }
          } else {
            const idx = minArr.indexOf(pid);
            if (idx >= 0) minArr.splice(idx, 1);
          }
          updateDetailBtnLabels();
        };
        el.appendChild(cb);
        const icon = STAT_ICONS[pid];
        if (icon) {
          const img = document.createElement("img");
          img.className = "sicon";
          img.src = `/icons/${icon}`;
          img.alt = "";
          el.appendChild(img);
        }
        const span = document.createElement("span");
        span.textContent = statName(pid);
        el.appendChild(span);
        fl.appendChild(el);
      });
    }
  } else {
    const current = { req: optRequired, des: optDesired, excl: optExcluded }[category];
    const others = (["req", "des", "excl"] as const)
      .filter((k) => k !== category)
      .flatMap((k) => ({ req: optRequired, des: optDesired, excl: optExcluded }[k]));
    const otherSet = new Set(others);

    ALL_STAT_IDS.forEach((pid) => {
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
            if (category === "req") {
              const mi = optMinRequired.indexOf(pid);
              if (mi >= 0) optMinRequired.splice(mi, 1);
            }
            if (category === "des") {
              const mi = optMinDesired.indexOf(pid);
              if (mi >= 0) optMinDesired.splice(mi, 1);
            }
          }
          updateDetailBtnLabels();
          updateOptBtnLabel("req");
          updateOptRunBtn();
        };
      }
      el.appendChild(cb);
      const icon = STAT_ICONS[pid];
      if (icon) {
        const img = document.createElement("img");
        img.className = "sicon";
        img.src = `/icons/${icon}`;
        img.alt = "";
        el.appendChild(img);
      }
      const span = document.createElement("span");
      span.textContent = statName(pid);
      el.appendChild(span);
      fl.appendChild(el);
    });
  }

  fl.classList.add("on");
  positionFlyout(fl, anchor);
}

// ========== Optimize (Web Workers) ==========

let optOverlay: HTMLElement | null = null;

async function runOptimize() {
  const btn = $<HTMLButtonElement>("opt-run");
  btn.classList.add("loading");
  btn.textContent = t.ui.btn_running;
  $("opt-empty").style.display = "none";
  $("opt-results").style.display = "none";

  optOverlay = createLoadingOverlay();
  $("opt-scroll").appendChild(optOverlay);

  const quality = Number($<HTMLSelectElement>("opt-quality").value);
  const speedMode = $<HTMLSelectElement>("opt-speed").value;
  const minThresholds: Record<number, number> = {};
  optMinRequired.forEach((pid) => { minThresholds[pid] = 20; });
  optMinDesired.forEach((pid) => { minThresholds[pid] = 16; });

  // 総当たりモード: 候補数を事前チェックし、600件超なら警告
  if (speedMode === "exhaustive") {
    const countRes = await new Promise<OptimizeResponse>((resolve, reject) => {
      workers[0].onmessage = (e: MessageEvent) => {
        const { type, data, error } = e.data;
        if (type === "error") reject(new Error(error));
        else if (type === "result") resolve(data as OptimizeResponse);
      };
      workers[0].postMessage({
        type: "optimize", modules,
        request: {
          required_stats: [...optRequired],
          desired_stats: [...optDesired],
          excluded_stats: [...optExcluded],
          min_quality: quality,
          speed_mode: speedMode,
          count_only: true,
        } satisfies OptimizeRequest,
      });
    });
    if (countRes.filtered_count > 600) {
      const msg = fmt(t.ui.exhaustive_warn_msg, { count: countRes.filtered_count });
      if (!confirm(msg)) {
        finishOptimize();
        return;
      }
    }
  }

  let completed = 0;
  let errored = false;
  const allCombinations: Combination[] = [];
  let filteredCount = 0;
  let totalModules = 0;

  for (let i = 0; i < numWorkers; i++) {
    const req: OptimizeRequest = {
      required_stats: [...optRequired],
      desired_stats: [...optDesired],
      excluded_stats: [...optExcluded],
      min_quality: quality,
      speed_mode: speedMode as OptimizeRequest["speed_mode"],
      worker_id: i,
      num_workers: numWorkers,
      min_thresholds: Object.keys(minThresholds).length > 0 ? minThresholds : undefined,
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

let pendingOcrGroups: OcrGroup[] = [];
let ocrImageZoomStates: { scale: number; translateX: number; translateY: number }[] = [];
let ocrCurrentPage = 0;
let hasStoredOcrData = false;

function openOcrConfirmationModal(groups: OcrGroup[], startPage = 0) {
  pendingOcrGroups = groups.map((g) => ({
    imageUrl: g.imageUrl,
    modules: g.modules.map((m) => ({ ...m, stats: m.stats.map((s) => ({ ...s })) })),
  }));
  ocrImageZoomStates = groups.map(() => ({ scale: 1, translateX: 0, translateY: 0 }));
  ocrCurrentPage = Math.min(startPage, groups.length - 1);
  hasStoredOcrData = true;
  saveOcrGroups(pendingOcrGroups, ocrCurrentPage).catch(() => {});
  renderOcrModalBody();
  $("ocr-modal-bd").classList.add("on");
}

/** ×ボタン: IndexedDBに保存したまま閉じる */
function closeOcrModal() {
  hasStoredOcrData = true;
  saveOcrGroups(pendingOcrGroups, ocrCurrentPage).catch(() => {});
  $("ocr-modal-bd").classList.remove("on");
  pendingOcrGroups = [];
  ocrImageZoomStates = [];
  ocrCurrentPage = 0;
}

/** 削除確認モーダルのOK後に実行するコールバック */
let ocrCancelCallback: (() => void) | null = null;

function showOcrDeleteConfirm(onConfirm: () => void) {
  ocrCancelCallback = onConfirm;
  $("ocr-cancel-modal-bd").classList.add("on");
}

/** キャンセルボタン: 確認後にIndexedDBから削除して閉じる */
function cancelOcrModal() {
  showOcrDeleteConfirm(() => {
    $("ocr-modal-bd").classList.remove("on");
    pendingOcrGroups = [];
    ocrImageZoomStates = [];
    ocrCurrentPage = 0;
  });
}

function confirmCancelOcr() {
  $("ocr-cancel-modal-bd").classList.remove("on");
  hasStoredOcrData = false;
  deleteOcrGroups().catch(() => {});
  if (ocrCancelCallback) {
    ocrCancelCallback();
    ocrCancelCallback = null;
  }
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

  const header = document.createElement("div");
  header.className = "ocr-group-header";

  const imgWrap = document.createElement("div");
  imgWrap.className = "ocr-group-img";
  const img = document.createElement("img");
  img.src = group.imageUrl;
  img.alt = fmt(t.ui.ocr_screenshot, { n: gi + 1 });
  imgWrap.appendChild(img);
  header.appendChild(imgWrap);

  const hint = document.createElement("div");
  hint.className = "ocr-group-hint";
  hint.textContent = t.ui.ocr_hint;
  header.appendChild(hint);

  section.appendChild(header);

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
        ${statDropdownHtml("ocr-stat-name", s.part_id, { gi: String(gi), mi: String(mi), si: String(si) })}
        <select class="opt-select ocr-stat-value" data-gi="${gi}" data-mi="${mi}" data-si="${si}">${valueOptions}</select>
        <button class="ocr-stat-remove" data-gi="${gi}" data-mi="${mi}" data-si="${si}">&times;</button>
      </div>`;
    }).join("");
    const addStatHtml = m.stats.length < 3
      ? `<button class="addbtn ocr-add-stat" data-gi="${gi}" data-mi="${mi}">${t.ui.add_stat}</button>`
      : "";

    row.innerHTML = [
      `<span class="ocr-row-index">${mi + 1}</span>`,
      `<div class="ocr-row-content">`,
        `<div class="ocr-row-header">`,
          `<div class="ocr-row-icon" id="ocr-icon-${gi}-${mi}">${moduleIconHtml(m.config_id)}</div>`,
          `<div class="ocr-row-fields">`,
            `<label class="form-field">`,
              `<span class="cmd-lbl">${t.ui.type_label}</span>`,
              `<select class="opt-select ocr-type" data-gi="${gi}" data-mi="${mi}">${typeSelectOptions(typeDigit)}</select>`,
            `</label>`,
            `<label class="form-field">`,
              `<span class="cmd-lbl">${t.ui.rarity_sub_label}</span>`,
              `<select class="opt-select ocr-rarity-sub" data-gi="${gi}" data-mi="${mi}">${raritySubSelectOptions(raritySub)}</select>`,
            `</label>`,
          `</div>`,
          `<button class="ocr-row-remove" data-gi="${gi}" data-mi="${mi}">&times;</button>`,
        `</div>`,
        `<div class="ocr-row-stats">`,
          `<div class="ocr-stat-divider"></div>`,
          `${statsHtml}${addStatHtml}`,
        `</div>`,
      `</div>`,
    ].join("");

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
      saveOcrGroups(pendingOcrGroups, ocrCurrentPage).catch(() => {});
      renderOcrModalBody();
    };
  });

  const newListEl = body.querySelector<HTMLElement>(".ocr-group-list");
  if (newListEl) newListEl.scrollTop = listScrollTop;

  body.querySelectorAll<HTMLSelectElement>(".ocr-type, .ocr-rarity-sub").forEach((sel) => {
    sel.onchange = () => {
      onOcrFieldChange(Number(sel.dataset.gi), Number(sel.dataset.mi));
      saveOcrGroups(pendingOcrGroups, ocrCurrentPage).catch(() => {});
    };
  });
  body.querySelectorAll<HTMLElement>(".ocr-stat-name").forEach((dd) => {
    dd.addEventListener("change", () => {
      pendingOcrGroups[Number(dd.dataset.gi)].modules[Number(dd.dataset.mi)].stats[Number(dd.dataset.si)].part_id = Number(dd.dataset.value);
      saveOcrGroups(pendingOcrGroups, ocrCurrentPage).catch(() => {});
    });
  });
  body.querySelectorAll<HTMLSelectElement>(".ocr-stat-value").forEach((sel) => {
    sel.onchange = () => {
      pendingOcrGroups[Number(sel.dataset.gi)].modules[Number(sel.dataset.mi)].stats[Number(sel.dataset.si)].value = Number(sel.value);
      saveOcrGroups(pendingOcrGroups, ocrCurrentPage).catch(() => {});
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
      saveOcrGroups(pendingOcrGroups, ocrCurrentPage).catch(() => {});
      renderOcrModalBody();
    };
  });
  body.querySelectorAll<HTMLButtonElement>(".ocr-stat-remove").forEach((btn) => {
    btn.onclick = () => {
      const g = Number(btn.dataset.gi);
      const mi = Number(btn.dataset.mi);
      const si = Number(btn.dataset.si);
      pendingOcrGroups[g].modules[mi].stats.splice(si, 1);
      saveOcrGroups(pendingOcrGroups, ocrCurrentPage).catch(() => {});
      renderOcrModalBody();
    };
  });
  body.querySelectorAll<HTMLButtonElement>(".ocr-add-stat").forEach((btn) => {
    btn.onclick = () => {
      const g = Number(btn.dataset.gi);
      const mi = Number(btn.dataset.mi);
      pendingOcrGroups[g].modules[mi].stats.push({ part_id: ALL_STAT_IDS[0], value: 1 });
      saveOcrGroups(pendingOcrGroups, ocrCurrentPage).catch(() => {});
      renderOcrModalBody();
    };
  });

  initStatDropdowns(body);
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
  if (all.length === 0) {
    hasStoredOcrData = false;
    deleteOcrGroups().catch(() => {});
    $("ocr-modal-bd").classList.remove("on");
    pendingOcrGroups = [];
    ocrImageZoomStates = [];
    ocrCurrentPage = 0;
    return;
  }
  modules.push(...all);
  saveModulesToStorage();
  renderGrid();
  updateOptRunBtn();
  hasStoredOcrData = false;
  deleteOcrGroups().catch(() => {});
  $("ocr-modal-bd").classList.remove("on");
  pendingOcrGroups = [];
  ocrImageZoomStates = [];
  ocrCurrentPage = 0;
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
      .map((v) => `<option value="${v}"${curStat && v === curStat.value ? " selected" : ""}>${v}</option>`)
      .join("");
    statRows.push(`<div class="ocr-stat-row" data-si="${i}">
      ${statDropdownHtml("edit-stat-name", curStat?.part_id, undefined, curStat ? undefined : t.ui.select_placeholder)}
      <select class="opt-select ocr-stat-value edit-stat-value">${valueOpts}</select>
      <button class="ocr-stat-remove edit-remove-stat" data-si="${i}">&times;</button>
    </div>`);
  }

  body.innerHTML = `<div class="ocr-row-content">
    <div class="ocr-row-header">
      <div class="ocr-row-icon" id="edit-icon-preview">${moduleIconHtml(m.config_id)}</div>
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
    </div>
    <div class="ocr-row-stats">
      <div class="ocr-stat-divider"></div>
      <div id="edit-stat-rows">${statRows.join("")}</div>
      ${editStatCount < 3 ? `<button class="addbtn" id="edit-add-stat">${t.ui.add_stat}</button>` : ""}
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

  initStatDropdowns(body);

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
  const rows = document.querySelectorAll<HTMLElement>("#edit-stat-rows .ocr-stat-row");
  const newStats: StatEntry[] = [];
  rows.forEach((row) => {
    const nameDd = row.querySelector<HTMLElement>(".edit-stat-name");
    const valueSelect = row.querySelector<HTMLSelectElement>(".edit-stat-value");
    if (!nameDd || !valueSelect) return;
    const partId = Number(nameDd.dataset.value);
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
  const rows = document.querySelectorAll<HTMLElement>("#edit-stat-rows .ocr-stat-row");
  for (const row of rows) {
    const nameDd = row.querySelector<HTMLElement>(".edit-stat-name");
    const valueSelect = row.querySelector<HTMLSelectElement>(".edit-stat-value");
    if (!nameDd || !valueSelect) continue;
    const partId = Number(nameDd.dataset.value);
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
      .map((v) => `<option value="${v}">${v}</option>`)
      .join("");
    statRows.push(`<div class="ocr-stat-row" data-si="${i}">
      ${statDropdownHtml("manual-stat-name", undefined, undefined, t.ui.select_placeholder)}
      <select class="opt-select ocr-stat-value manual-stat-value">${valueOpts}</select>
      <button class="ocr-stat-remove manual-remove-stat" data-si="${i}">&times;</button>
    </div>`);
  }

  const defaultConfigId = buildConfigId(1, 1);
  body.innerHTML = `<div class="ocr-row-content">
    <div class="ocr-row-header">
      <div class="ocr-row-icon" id="manual-icon-preview">${moduleIconHtml(defaultConfigId)}</div>
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
    </div>
    <div class="ocr-row-stats">
      <div class="ocr-stat-divider"></div>
      <div id="manual-stat-rows">${statRows.join("")}</div>
      ${manualStatCount < 3 ? `<button class="addbtn" id="manual-add-stat">${t.ui.add_stat}</button>` : ""}
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

  initStatDropdowns(body);

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
  const rows = document.querySelectorAll<HTMLElement>("#manual-stat-rows .ocr-stat-row");
  const usedIds = new Set<number>();

  for (const row of rows) {
    const nameDd = row.querySelector<HTMLElement>(".manual-stat-name");
    const valueSelect = row.querySelector<HTMLSelectElement>(".manual-stat-value");
    if (!nameDd || !valueSelect) continue;
    const partId = Number(nameDd.dataset.value);
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

const SCREENSHOT_INFO_SEEN_KEY = "screenshot-info-seen";

function showScreenshotInfo(onClose?: () => void) {
  const body = $("screenshot-info-body");
  while (body.firstChild) body.removeChild(body.firstChild);
  const items = [
    { text: t.ui.screenshot_info_overview, style: "margin:0 0 10px;font-size:13px;line-height:1.6" },
    { text: t.ui.screenshot_info_edit, style: "margin:0 0 10px;font-size:13px;line-height:1.6" },
    { text: t.ui.screenshot_info_resume, style: "margin:0 0 4px;font-size:13px;line-height:1.6" },
    { text: t.ui.screenshot_info_resume_warn, style: "margin:0 0 10px;font-size:12px;color:#e8a735;line-height:1.6" },
    { text: t.ui.screenshot_info_delete, style: "margin:0 0 10px;font-size:13px;line-height:1.6" },
    { text: t.ui.screenshot_info_download, style: "margin:0 0 10px;font-size:13px;line-height:1.6" },
    { text: t.ui.screenshot_info_privacy, style: "margin:0;font-size:13px;line-height:1.6" },
  ];
  items.forEach(({ text, style }) => { const p = document.createElement("p"); p.textContent = text; p.style.cssText = style; body.appendChild(p); });
  screenshotInfoOnClose = onClose ?? null;
  $("screenshot-info-bd").classList.add("on");
}

let screenshotInfoOnClose: (() => void) | null = null;

function closeScreenshotInfo() {
  $("screenshot-info-bd").classList.remove("on");
  const cb = screenshotInfoOnClose;
  screenshotInfoOnClose = null;
  if (cb) cb();
}

function importScreenshot() {
  if (!localStorage.getItem(SCREENSHOT_INFO_SEEN_KEY)) {
    localStorage.setItem(SCREENSHOT_INFO_SEEN_KEY, "1");
    showScreenshotInfo(() => importScreenshot());
    return;
  }
  if (hasStoredOcrData) {
    $("ocr-prev-modal-bd").classList.add("on");
    return;
  }
  startNewImport();
}

function restoreOcrGroups() {
  $("ocr-prev-modal-bd").classList.remove("on");
  loadOcrGroups().then((data) => {
    if (data && data.groups.length > 0) {
      openOcrConfirmationModal(data.groups, data.currentPage);
    }
  }).catch(() => {});
}

function startNewImport() {
  $("ocr-prev-modal-bd").classList.remove("on");
  hasStoredOcrData = false;
  deleteOcrGroups().catch(() => {});
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

    let ocrWorker: any = null;
    try {
      const { createWorker } = await import("tesseract.js");
      ocrWorker = await createWorker("eng");
      await ocrWorker.setParameters({
        tessedit_char_whitelist: "+0123456789",
        tessedit_pageseg_mode: "7" as any,
      });

      for (let fi = 0; fi < files.length; fi++) {
        const file = files[fi];
        const imageUrl = URL.createObjectURL(file);
        const img = new Image();
        img.src = imageUrl;
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("画像の読み込みに失敗しました"));
        });
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
      if (ocrWorker) await ocrWorker.terminate();
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

// ========== JSON Import ==========

function importJson() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(reader.result as string);
        if (!Array.isArray(raw)) {
          showToast(t.ui.json_import_error, "error");
          return;
        }
        const imported: ModuleInput[] = [];
        for (const item of raw) {
          if (typeof item !== "object" || item === null) continue;
          // Extract stats: support both Tauri format ({name, part_id, value}) and Web format ({part_id, value})
          const stats: StatEntry[] = [];
          if (Array.isArray(item.stats)) {
            for (const s of item.stats) {
              if (typeof s.part_id === "number" && typeof s.value === "number") {
                stats.push({ part_id: s.part_id, value: s.value });
              }
            }
          }
          if (stats.length === 0) continue;
          const uuid = Date.now() + Math.floor(Math.random() * 1000);
          const config_id = typeof item.config_id === "number" ? item.config_id : null;
          const quality = typeof item.quality === "number" ? item.quality : null;
          imported.push({ uuid, config_id, quality, stats });
        }
        if (imported.length === 0) {
          showToast(t.ui.json_import_empty, "error");
          return;
        }
        modules.push(...imported);
        saveModulesToStorage();
        renderGrid();
        updateOptRunBtn();
        showToast(fmt(t.ui.json_import_success, { count: imported.length }), "success");
      } catch {
        showToast(t.ui.json_import_error, "error");
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

// ========== Backup Export ==========

function exportBackup() {
  if (modules.length === 0) {
    showToast(t.ui.backup_empty, "error");
    return;
  }
  const data = modules.map((m) => ({
    config_id: m.config_id,
    quality: m.quality,
    stats: m.stats.map((s) => ({
      part_id: s.part_id,
      value: s.value,
    })),
  }));
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "modules.json";
  a.click();
  URL.revokeObjectURL(url);
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

  // ---- PC: click to zoom toggle + drag to pan ----
  const DRAG_THRESHOLD = 5;
  let mouseDown = false;
  let didDrag = false;
  let mDownX = 0;
  let mDownY = 0;
  let mPanStartTX = 0;
  let mPanStartTY = 0;

  container.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    mouseDown = true;
    didDrag = false;
    mDownX = e.clientX;
    mDownY = e.clientY;
    mPanStartTX = translateX;
    mPanStartTY = translateY;
    if (scale > 1) container.style.cursor = "grabbing";
  });

  window.addEventListener("mousemove", (e) => {
    if (!mouseDown) return;
    const dx = e.clientX - mDownX;
    const dy = e.clientY - mDownY;
    if (!didDrag && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    didDrag = true;
    if (scale > 1) {
      translateX = mPanStartTX + dx;
      translateY = mPanStartTY + dy;
      clampTranslate();
      applyTransform();
    }
  });

  window.addEventListener("mouseup", (e) => {
    if (!mouseDown) return;
    mouseDown = false;
    container.style.cursor = "";
    if (didDrag) return;
    // click (no drag) → toggle zoom
    const rect = container.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    if (scale <= 1) {
      // zoom in to 2x, centering on click point
      const newScale = 2;
      translateX = clickX - clickX * newScale;
      translateY = clickY - clickY * newScale;
      scale = newScale;
      clampTranslate();
    } else {
      // zoom out to 1x
      scale = 1;
      translateX = 0;
      translateY = 0;
    }
    applyTransform();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initLang();
  applyI18n();
  document.documentElement.lang = getSavedLang() === "ko" ? "ko" : getSavedLang() === "en" ? "en" : "ja";

  loadModulesFromStorage();
  hasOcrGroups().then((v) => { hasStoredOcrData = v; }).catch(() => {});

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
    const statItems = ALL_STAT_IDS.map((id) => {
      const icon = STAT_ICONS[id];
      return { label: statName(id), val: String(id), disabled: ex.has(String(id)), iconSrc: icon ? `/icons/${icon}` : undefined };
    });
    openFly("fly-s", e.currentTarget as HTMLElement, [...extraItems, ...statItems], (it) => {
      sortKeys.push({ k: it.val, d: 1 });
      renderSChips();
      renderGrid();
    });
  };

  $("opt-btn-req").onclick = (e) => openOptMultiFly(e.currentTarget as HTMLElement, "req");

  // 詳細設定モーダル
  $("opt-detail-btn").onclick = () => openDetailModal();
  $("detail-btn-req").onclick = (e) => openDetailFly(e.currentTarget as HTMLElement, "req");
  $("detail-btn-des").onclick = (e) => openDetailFly(e.currentTarget as HTMLElement, "des");
  $("detail-btn-excl").onclick = (e) => openDetailFly(e.currentTarget as HTMLElement, "excl");
  $("detail-btn-min-req").onclick = (e) => openDetailFly(e.currentTarget as HTMLElement, "min-req");
  $("detail-btn-min-des").onclick = (e) => openDetailFly(e.currentTarget as HTMLElement, "min-des");
  $("detail-confirm").onclick = () => closeDetailModal();
  $("detail-modal-close").onclick = () => closeDetailModal();
  $("detail-modal-bd").onclick = (e) => {
    if (e.target === $("detail-modal-bd")) closeDetailModal();
  };

  $("opt-quality").onchange = () => { minQuality = Number($<HTMLSelectElement>("opt-quality").value); saveOptState(); };
  $("opt-run").onclick = () => runOptimize();

  $("speed-info-btn").onclick = () => {
    const body = $("speed-info-body");
    while (body.firstChild) body.removeChild(body.firstChild);
    const desc = document.createElement("p");
    desc.textContent = t.ui.speed_info_desc;
    desc.style.cssText = "margin:0 0 12px;font-size:13px;line-height:1.6";
    body.appendChild(desc);
    const items = [t.ui.speed_info_standard, t.ui.speed_info_precise, t.ui.speed_info_most_precise, t.ui.speed_info_exhaustive];
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
  const patsaveMode = $<HTMLSelectElement>("patsave-mode");
  const patsaveNameRow = $("patsave-name-row");

  const updatePatsaveNameRow = () => {
    const isNew = patsaveMode.value === "new";
    patsaveNameRow.style.display = isNew ? "block" : "none";
  };
  patsaveMode.onchange = updatePatsaveNameRow;

  const openPatsaveModal = () => {
    const patSel = $<HTMLSelectElement>("pattern-select");
    const selectedIdx = patSel.value;
    const patterns = getPatterns();
    patsaveMode.textContent = "";

    if (selectedIdx !== "" && patterns[Number(selectedIdx)]) {
      const p = patterns[Number(selectedIdx)];
      const overwriteOpt = document.createElement("option");
      overwriteOpt.value = "overwrite";
      overwriteOpt.textContent = fmt(t.ui.pattern_overwrite, { name: p.name });
      patsaveMode.appendChild(overwriteOpt);
    }
    const newOpt = document.createElement("option");
    newOpt.value = "new";
    newOpt.textContent = t.ui.pattern_new;
    patsaveMode.appendChild(newOpt);

    patsaveInput.value = "";
    updatePatsaveNameRow();
    patsaveBd.classList.add("on");
  };

  const closePatsaveModal = () => { patsaveBd.classList.remove("on"); };

  const confirmPatsave = () => {
    const mode = patsaveMode.value;
    const quality = Number($<HTMLSelectElement>("opt-quality").value);
    const patterns = getPatterns();

    if (mode === "overwrite") {
      const idx = Number($<HTMLSelectElement>("pattern-select").value);
      const existing = patterns[idx];
      if (!existing) return;
      const entry: OptPattern = { name: existing.name, required: [...optRequired], desired: [...optDesired], excluded: [...optExcluded], quality, min_required: [...optMinRequired], min_desired: [...optMinDesired] };
      patterns[idx] = entry;
      savePatterns(patterns);
      closePatsaveModal();
      renderPatternSelect();
      $<HTMLSelectElement>("pattern-select").value = String(idx);
      updatePatternButtons();
    } else {
      const name = patsaveInput.value.trim();
      if (!name) return;
      const duplicateIdx = patterns.findIndex((p) => p.name === name);
      const entry: OptPattern = { name, required: [...optRequired], desired: [...optDesired], excluded: [...optExcluded], quality, min_required: [...optMinRequired], min_desired: [...optMinDesired] };
      if (duplicateIdx >= 0) patterns[duplicateIdx] = entry;
      else patterns.push(entry);
      savePatterns(patterns);
      closePatsaveModal();
      renderPatternSelect();
      $<HTMLSelectElement>("pattern-select").value = String(duplicateIdx >= 0 ? duplicateIdx : patterns.length - 1);
      updatePatternButtons();
    }
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
  $("ocr-cancel").onclick = cancelOcrModal;
  $("ocr-modal-close").onclick = closeOcrModal;
  $("ocr-prev").onclick = () => { ocrCurrentPage--; renderOcrModalBody(); $("ocr-modal-body").querySelector(".ocr-group-list")?.scrollTo(0, 0); };
  $("ocr-next").onclick = () => { ocrCurrentPage++; renderOcrModalBody(); $("ocr-modal-body").querySelector(".ocr-group-list")?.scrollTo(0, 0); };

  // OCR cancel confirm modal
  $("ocr-cancel-ok").onclick = confirmCancelOcr;
  $("ocr-cancel-back").onclick = () => $("ocr-cancel-modal-bd").classList.remove("on");
  $("ocr-cancel-modal-close").onclick = () => $("ocr-cancel-modal-bd").classList.remove("on");
  $("ocr-cancel-modal-bd").onclick = (e) => { if (e.target === $("ocr-cancel-modal-bd")) $("ocr-cancel-modal-bd").classList.remove("on"); };

  // OCR previous data modal
  $("ocr-prev-restore").onclick = restoreOcrGroups;
  $("ocr-prev-new").onclick = () => {
    $("ocr-prev-modal-bd").classList.remove("on");
    showOcrDeleteConfirm(() => { startNewImport(); });
  };
  $("ocr-prev-modal-close").onclick = () => $("ocr-prev-modal-bd").classList.remove("on");
  $("ocr-prev-modal-bd").onclick = (e) => { if (e.target === $("ocr-prev-modal-bd")) $("ocr-prev-modal-bd").classList.remove("on"); };

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
  $("screenshot-info-btn").onclick = () => showScreenshotInfo();
  $("screenshot-info-close").onclick = () => closeScreenshotInfo();
  $("screenshot-info-bd").onclick = (e) => { if (e.target === $("screenshot-info-bd")) closeScreenshotInfo(); };
  $("json-import-btn").onclick = () => importJson();
  $("clear-btn").onclick = () => clearModules();

  // Sidebar
  $("backup-export-btn").onclick = () => exportBackup();
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
