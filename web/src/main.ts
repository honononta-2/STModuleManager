import {
  STAT_NAMES, STAT_ICONS, ALL_STAT_IDS, ALL_STAT_NAMES,
  MODULE_TYPES, statName, statIdByName, configIdToType, configIdToIcon,
} from "@shared/stats";
import type {
  Combination, CombinationModule, ModuleInput, OptimizeRequest,
  OptimizeResponse, StatEntry, StatTotal,
} from "@shared/types";
import { processScreenshot } from "./ocr";

// --- Helpers ---
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function positionFlyout(fl: HTMLElement, anchor: HTMLElement) {
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  let left = r.left;
  // Ensure flyout stays within viewport on mobile
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
const RARITY_LABEL: Record<Rarity, string> = { orange: "橙", gold: "金", purple: "紫", blue: "青" };
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

// config_id = 5500000 + typeDigit*100 + raritySub
function configIdToComponents(configId: number | null): { typeDigit: number; raritySub: number } | null {
  if (configId == null) return null;
  const lower = configId % 1000;
  return { typeDigit: Math.floor(lower / 100), raritySub: lower % 100 };
}

function buildConfigId(typeDigit: number, raritySub: number): number {
  return 5500000 + typeDigit * 100 + raritySub;
}

const RARITY_SUB_TO_QUALITY: Record<number, number> = { 1: 2, 2: 3, 3: 4, 4: 4 };

const STAT_NAME_TO_ID: Record<string, number> = Object.fromEntries(
  Object.entries(STAT_NAMES).map(([id, name]) => [name, Number(id)]),
);

// --- State ---
let modules: ModuleInput[] = [];

// Filter / sort
let filterRarities: Rarity[] = [];
let filterStats: string[] = [];
let filterTypes: string[] = [];
let filterMode: "and" | "or" = "and";
let sortKeys: { k: string; d: number }[] = [];

// Optimizer
let optRequired: string[] = [];
let optDesired: string[] = [];
let optExcluded: string[] = [];
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

// ========== Grid rendering (ported from desktop) ==========

function renderGrid() {
  let ms = [...modules];

  // Filters
  if (filterRarities.length > 0) {
    ms = ms.filter((m) => filterRarities.includes(qualityToRarity(m.quality)));
  }
  if (filterTypes.length > 0) {
    ms = ms.filter((m) => filterTypes.some((t) => configIdToType(m.config_id) === t));
  }
  if (filterStats.length > 0) {
    ms = filterMode === "and"
      ? ms.filter((m) => filterStats.every((f) => m.stats.some((s) => statName(s.part_id) === f)))
      : ms.filter((m) => filterStats.some((f) => m.stats.some((s) => statName(s.part_id) === f)));
  }

  // Sort
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
    g.innerHTML = '<div class="empty"><div style="font-size:24px;opacity:0.25">○</div><div style="font-size:13px">モジュールがありません</div></div>';
    $("sb-n").textContent = "0 モジュール";
    $("sb-i").textContent = "";
    return;
  }

  ms.forEach((m, i) => {
    const c = document.createElement("div");
    c.className = "card";
    c.style.animationDelay = `${Math.min(i, 16) * 14}ms`;
    const r = qualityToRarity(m.quality);
    c.innerHTML = `
      <div class="card-head">
        ${moduleIconHtml(m.config_id)}
        <span class="rbadge ${r}">${RARITY_LABEL[r]}</span>
        <button class="card-edit-btn" data-uuid="${m.uuid}" title="編集">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
        </button>
      </div>
      <div class="divider"></div>
      <div class="stats">${m.stats.map((s) => `
        <div class="srow">
          ${statIcon(s.part_id)}<span class="sname">${statName(s.part_id)}</span>
          <div class="sbar-w"><div class="sbar" style="width:${s.value * 10}%"></div></div>
          <span class="sval">+${s.value}</span>
        </div>`).join("")}
      </div>`;
    c.querySelector<HTMLButtonElement>(".card-edit-btn")!.onclick = (e) => {
      e.stopPropagation();
      openEditModal(m.uuid);
    };
    g.appendChild(c);
  });

  $("sb-n").textContent = `${ms.length} モジュール`;
  const info: string[] = [];
  const filterCount = filterRarities.length + filterTypes.length + filterStats.length;
  if (filterCount) info.push(`絞込 ${filterCount}件(${filterMode.toUpperCase()})`);
  $("sb-i").textContent = info.join("　");
}

// ========== Filter flyout ==========

function updateFilterBtnLabel() {
  const count = filterRarities.length + filterTypes.length + filterStats.length;
  const btn = $("filter-btn");
  btn.textContent = count > 0 ? `${count}件選択` : "未選択";
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

const RARITY_FILTERS: { label: string; value: Rarity }[] = [
  { label: "金", value: "gold" },
  { label: "紫", value: "purple" },
  { label: "青", value: "blue" },
];

function openFilterMultiFly(anchor: HTMLElement) {
  const fl = $("fly-filter");
  if (fl.classList.contains("on")) { closeFly(); return; }
  closeFly();
  fl.innerHTML = "";
  const refresh = () => { updateFilterBtnLabel(); renderGrid(); };

  addFlySection(fl, "レアリティ",
    RARITY_FILTERS.map((r) => ({ label: r.label, checked: filterRarities.includes(r.value) })),
    (i, checked) => {
      const val = RARITY_FILTERS[i].value;
      if (checked) filterRarities.push(val);
      else { const idx = filterRarities.indexOf(val); if (idx >= 0) filterRarities.splice(idx, 1); }
      refresh();
    },
  );

  addFlySection(fl, "型",
    MODULE_TYPES.map((t) => ({ label: t, checked: filterTypes.includes(t) })),
    (i, checked) => {
      const val = MODULE_TYPES[i];
      if (checked) filterTypes.push(val);
      else { const idx = filterTypes.indexOf(val); if (idx >= 0) filterTypes.splice(idx, 1); }
      refresh();
    },
  );

  addFlySection(fl, "ステータス",
    ALL_STAT_NAMES.map((n) => ({ label: n, checked: filterStats.includes(n) })),
    (i, checked) => {
      const val = ALL_STAT_NAMES[i];
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
  c.innerHTML = "";
  sortKeys.forEach((s) => {
    const lbl = s.k === "rarity" ? "レアリティ" : s.k === "total" ? "合計値" : s.k;
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
    if (rm) rm.onclick = (e) => {
      e.stopPropagation();
      const idx = sortKeys.indexOf(s);
      if (idx >= 0) sortKeys.splice(idx, 1);
      renderSChips();
      renderGrid();
    };
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

interface OptPattern {
  name: string;
  required: string[];
  desired: string[];
  excluded: string[];
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
    if (Array.isArray(s.required)) optRequired = s.required.filter((n: string) => ALL_STAT_NAMES.includes(n));
    if (Array.isArray(s.desired)) optDesired = s.desired.filter((n: string) => ALL_STAT_NAMES.includes(n));
    if (Array.isArray(s.excluded)) optExcluded = s.excluded.filter((n: string) => ALL_STAT_NAMES.includes(n));
    if (s.quality) $<HTMLSelectElement>("opt-quality").value = String(s.quality);
  } catch { /* ignore */ }
}

function getPatterns(): OptPattern[] {
  const raw = localStorage.getItem(OPT_PATTERNS_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function savePatterns(patterns: OptPattern[]) {
  localStorage.setItem(OPT_PATTERNS_KEY, JSON.stringify(patterns));
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
  optRequired = p.required.filter((n) => ALL_STAT_NAMES.includes(n));
  optDesired = p.desired.filter((n) => ALL_STAT_NAMES.includes(n));
  optExcluded = p.excluded.filter((n) => ALL_STAT_NAMES.includes(n));
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
  btn.textContent = items.length > 0 ? `${items.length}件選択` : "未選択";
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
        if (cb.checked) current.push(name);
        else { const idx = current.indexOf(name); if (idx >= 0) current.splice(idx, 1); }
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
  btn.textContent = "計算中...";
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
    const req: OptimizeRequest = {
      required_stats: optRequired.map((n) => STAT_NAME_TO_ID[n]).filter(Boolean),
      desired_stats: optDesired.map((n) => STAT_NAME_TO_ID[n]).filter(Boolean),
      excluded_stats: optExcluded.map((n) => STAT_NAME_TO_ID[n]).filter(Boolean),
      min_quality: quality,
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
  btn.textContent = "最適化実行";
}

// ========== Opt Results ==========

function renderOptResults(res: OptimizeResponse) {
  const empty = $("opt-empty");
  const results = $("opt-results");

  if (res.combinations.length === 0) {
    results.style.display = "none";
    empty.style.display = "flex";
    empty.innerHTML = '<div style="font-size:28px;opacity:0.22">○</div><div>条件に合う組み合わせが見つかりませんでした</div>';
    return;
  }

  empty.style.display = "none";
  results.style.display = "flex";
  results.innerHTML = "";

  const info = document.createElement("div");
  info.className = "opt-info";
  info.textContent = `${res.total_modules}件中 ${res.filtered_count}件のモジュールから探索 — 上位${res.combinations.length}件`;
  results.appendChild(info);

  res.combinations.forEach((comb) => {
    const card = document.createElement("div");
    card.className = "opt-card";
    card.style.animationDelay = `${(comb.rank - 1) * 30}ms`;
    const rankClass = comb.rank === 1 ? "r1" : comb.rank === 2 ? "r2" : comb.rank === 3 ? "r3" : "";
    const statTags = comb.stat_totals
      .map((st) => {
        const cls = st.is_required ? "req" : "des";
        return `<span class="opt-stat-tag ${cls}">${statIcon(st.part_id)}<span>${statName(st.part_id)}</span> <span class="bp">+${st.total}</span></span>`;
      }).join("");

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

// ========== Result Detail Modal ==========

function openModal(comb: Combination) {
  const bd = $("modal-bd");
  const body = $("modal-body");
  $("modal-title").textContent = `#${comb.rank} 組み合わせ詳細`;

  const modsHtml = comb.modules.map((m) => {
    const statsHtml = m.stats.map((s) => `
      <div class="srow">
        ${statIcon(s.part_id)}<span class="sname">${statName(s.part_id)}</span>
        <div class="sbar-w"><div class="sbar" style="width:${s.value * 10}%"></div></div>
        <span class="sval">+${s.value}</span>
      </div>`).join("");
    const origMod = modules.find((om) => om.uuid === m.uuid);
    return `
      <div class="modal-mod">
        <div class="modal-mod-head">${moduleIconHtml(origMod?.config_id ?? null)}</div>
        <div class="stats">${statsHtml}</div>
      </div>`;
  }).join("");

  const statTotalsMap = new Map<number, number>();
  comb.modules.forEach((m) => m.stats.forEach((s) => {
    statTotalsMap.set(s.part_id, (statTotalsMap.get(s.part_id) ?? 0) + s.value);
  }));
  const reqIds = new Set(comb.stat_totals.filter((st) => st.is_required).map((st) => st.part_id));
  const desIds = new Set(comb.stat_totals.filter((st) => !st.is_required).map((st) => st.part_id));

  const rowsHtml = Array.from(statTotalsMap.entries())
    .sort((a, b) => {
      const aP = reqIds.has(a[0]) ? 0 : desIds.has(a[0]) ? 1 : 2;
      const bP = reqIds.has(b[0]) ? 0 : desIds.has(b[0]) ? 1 : 2;
      return aP !== bP ? aP - bP : b[1] - a[1];
    })
    .map(([pid, total]) => {
      const typeTag = reqIds.has(pid) ? `<span class="type-req">メイン</span>` : desIds.has(pid) ? `<span class="type-des">サブ</span>` : "";
      return `<tr><td>${statIcon(pid)} ${statName(pid)}</td><td class="val">+${total}</td><td>${typeTag}</td></tr>`;
    }).join("");

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

function closeModal() { $("modal-bd").classList.remove("on"); }

// ========== OCR Confirmation Modal ==========

interface OcrGroup {
  imageUrl: string;
  modules: ModuleInput[];
}

let pendingOcrGroups: OcrGroup[] = [];
let ocrImageZoomStates: { scale: number; translateX: number; translateY: number }[] = [];

function openOcrConfirmationModal(groups: OcrGroup[]) {
  pendingOcrGroups = groups.map((g) => ({
    imageUrl: g.imageUrl,
    modules: g.modules.map((m) => ({ ...m, stats: m.stats.map((s) => ({ ...s })) })),
  }));
  ocrImageZoomStates = groups.map(() => ({ scale: 1, translateX: 0, translateY: 0 }));
  renderOcrModalBody();
  $("ocr-modal-bd").classList.add("on");
}

function closeOcrModal() {
  $("ocr-modal-bd").classList.remove("on");
  pendingOcrGroups.forEach((g) => URL.revokeObjectURL(g.imageUrl));
  pendingOcrGroups = [];
  ocrImageZoomStates = [];
}

function allPendingModules(): ModuleInput[] {
  return pendingOcrGroups.flatMap((g) => g.modules);
}

function renderOcrModalBody() {
  const body = $("ocr-modal-body");
  const allMods = allPendingModules();

  if (allMods.length === 0) {
    body.innerHTML = '<div class="ocr-empty">検出されたモジュールがありません</div>';
    return;
  }

  // スクロール位置を保存
  const bodyScrollTop = body.scrollTop;
  const listScrollTops: number[] = [];
  body.querySelectorAll<HTMLElement>(".ocr-group-list").forEach((el) => {
    listScrollTops.push(el.scrollTop);
  });

  body.innerHTML = "";

  pendingOcrGroups.forEach((group, gi) => {
    const section = document.createElement("div");
    section.className = "ocr-group";

    // 画像プレビュー（ピンチ拡大可能）
    const imgWrap = document.createElement("div");
    imgWrap.className = "ocr-group-img";
    imgWrap.innerHTML = `<img src="${group.imageUrl}" alt="スクリーンショット ${gi + 1}">`;
    section.appendChild(imgWrap);

    // ヒントテキスト
    const hint = document.createElement("div");
    hint.className = "ocr-group-hint";
    hint.textContent = "\u203B \u30B9\u30DE\u30DB\u306F\u753B\u50CF\u3092\u30D4\u30F3\u30C1\u3067\u62E1\u5927\u8868\u793A\u3067\u304D\u307E\u3059";
    section.appendChild(hint);

    // モジュール一覧（個別スクロール）
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
        const statOptions = ALL_STAT_IDS.map((id) =>
          `<option value="${id}"${id === s.part_id ? " selected" : ""}>${statName(id)}</option>`
        ).join("");
        const valueOptions = Array.from({ length: 10 }, (_, i) => i + 1)
          .map((v) => `<option value="${v}"${v === s.value ? " selected" : ""}>${v}</option>`)
          .join("");
        return `<div class="ocr-stat-row">
          <select class="opt-select ocr-stat-name" data-gi="${gi}" data-mi="${mi}" data-si="${si}">${statOptions}</select>
          <select class="opt-select ocr-stat-value" data-gi="${gi}" data-mi="${mi}" data-si="${si}">${valueOptions}</select>
          <button class="ocr-stat-remove" data-gi="${gi}" data-mi="${mi}" data-si="${si}">&times;</button>
        </div>`;
      }).join("");
      const addStatHtml = m.stats.length < 3
        ? `<button class="addbtn ocr-add-stat" data-gi="${gi}" data-mi="${mi}">+ ステータス追加</button>`
        : "";

      row.innerHTML = `
        <span class="ocr-row-index">${mi + 1}</span>
        <div class="ocr-row-icon" id="ocr-icon-${gi}-${mi}">${moduleIconHtml(m.config_id)}</div>
        <div class="ocr-row-body">
          <div class="ocr-row-fields">
            <label class="form-field">
              <span class="cmd-lbl">型</span>
              <select class="opt-select ocr-type" data-gi="${gi}" data-mi="${mi}">
                <option value="1"${typeDigit === 1 ? " selected" : ""}>攻撃</option>
                <option value="2"${typeDigit === 2 ? " selected" : ""}>支援</option>
                <option value="3"${typeDigit === 3 ? " selected" : ""}>防御</option>
              </select>
            </label>
            <label class="form-field">
              <span class="cmd-lbl">レア種別</span>
              <select class="opt-select ocr-rarity-sub" data-gi="${gi}" data-mi="${mi}">
                <option value="1"${raritySub === 1 ? " selected" : ""}>青</option>
                <option value="2"${raritySub === 2 ? " selected" : ""}>紫</option>
                <option value="3"${raritySub === 3 ? " selected" : ""}>金A</option>
                <option value="4"${raritySub === 4 ? " selected" : ""}>金B</option>
              </select>
            </label>
          </div>
          <div class="ocr-row-stats">${statsHtml}${addStatHtml}</div>
        </div>
        <button class="ocr-row-remove" data-gi="${gi}" data-mi="${mi}">&times;</button>`;

      listWrap.appendChild(row);
    });

    // モジュール追加ボタン
    const addBtn = document.createElement("button");
    addBtn.className = "addbtn ocr-group-add";
    addBtn.textContent = "+ モジュール追加";
    addBtn.dataset.gi = String(gi);
    listWrap.appendChild(addBtn);

    section.appendChild(listWrap);
    body.appendChild(section);

    // 画像ピンチズームを有効化
    setupImagePinchZoom(imgWrap, gi);
  });

  // モジュール追加
  body.querySelectorAll<HTMLButtonElement>(".ocr-group-add").forEach((btn) => {
    btn.onclick = () => {
      const gi = Number(btn.dataset.gi);
      pendingOcrGroups[gi].modules.push({
        uuid: Date.now() + Math.floor(Math.random() * 1000),
        config_id: buildConfigId(1, 2),
        quality: 3,
        stats: [{ part_id: ALL_STAT_IDS[0], value: 1 }],
      });
      renderOcrModalBody();
    };
  });

  // スクロール位置を復元
  body.scrollTop = bodyScrollTop;
  body.querySelectorAll<HTMLElement>(".ocr-group-list").forEach((el, i) => {
    if (i < listScrollTops.length) el.scrollTop = listScrollTops[i];
  });

  // Bind events
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
  // モジュール行削除
  body.querySelectorAll<HTMLButtonElement>(".ocr-row-remove").forEach((btn) => {
    btn.onclick = () => {
      const gi = Number(btn.dataset.gi);
      const mi = Number(btn.dataset.mi);
      pendingOcrGroups[gi].modules.splice(mi, 1);
      if (pendingOcrGroups[gi].modules.length === 0) {
        URL.revokeObjectURL(pendingOcrGroups[gi].imageUrl);
        pendingOcrGroups.splice(gi, 1);
      }
      renderOcrModalBody();
    };
  });
  // ステータス削除
  body.querySelectorAll<HTMLButtonElement>(".ocr-stat-remove").forEach((btn) => {
    btn.onclick = () => {
      const gi = Number(btn.dataset.gi);
      const mi = Number(btn.dataset.mi);
      const si = Number(btn.dataset.si);
      pendingOcrGroups[gi].modules[mi].stats.splice(si, 1);
      renderOcrModalBody();
    };
  });
  // ステータス追加
  body.querySelectorAll<HTMLButtonElement>(".ocr-add-stat").forEach((btn) => {
    btn.onclick = () => {
      const gi = Number(btn.dataset.gi);
      const mi = Number(btn.dataset.mi);
      pendingOcrGroups[gi].modules[mi].stats.push({ part_id: ALL_STAT_IDS[0], value: 1 });
      renderOcrModalBody();
    };
  });
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
    const options = ALL_STAT_IDS.map((id) =>
      `<option value="${id}"${curStat && id === curStat.part_id ? " selected" : ""}>${statName(id)}</option>`
    ).join("");
    const valueOpts = Array.from({ length: 10 }, (_, v) => v + 1)
      .map((v) => `<option value="${v}"${curStat && v === curStat.value ? " selected" : ""}>　${v}</option>`)
      .join("");
    statRows.push(`<div class="stat-input-group" data-si="${i}">
      <select class="opt-select edit-stat-name">${curStat ? "" : '<option value="">-- 選択 --</option>'}${options}</select>
      <select class="opt-select edit-stat-value">${valueOpts}</select>
      ${i > 0 ? `<button class="ocr-stat-remove edit-remove-stat" data-si="${i}">&times;</button>` : ""}
    </div>`);
  }

  body.innerHTML = `<div class="manual-form">
    <div class="edit-icon-preview" id="edit-icon-preview">${moduleIconHtml(m.config_id)}</div>
    <div class="form-row">
      <label class="form-field">
        <span class="cmd-lbl">型</span>
        <select class="opt-select" id="edit-type">
          <option value="1"${typeDigit === 1 ? " selected" : ""}>攻撃</option>
          <option value="2"${typeDigit === 2 ? " selected" : ""}>支援</option>
          <option value="3"${typeDigit === 3 ? " selected" : ""}>防御</option>
        </select>
      </label>
      <label class="form-field">
        <span class="cmd-lbl">レア種別</span>
        <select class="opt-select" id="edit-rarity-sub">
          <option value="1"${raritySub === 1 ? " selected" : ""}>青</option>
          <option value="2"${raritySub === 2 ? " selected" : ""}>紫</option>
          <option value="3"${raritySub === 3 ? " selected" : ""}>金A</option>
          <option value="4"${raritySub === 4 ? " selected" : ""}>金B</option>
        </select>
      </label>
    </div>
    <div class="manual-stats-section">
      <div class="cmd-lbl">ステータス</div>
      <div id="edit-stat-rows">${statRows.join("")}</div>
      ${editStatCount < 3 ? `<button class="addbtn" id="edit-add-stat">+ ステータス追加</button>` : ""}
    </div>
  </div>`;

  // Icon preview update on type/rarity change
  const updateIconPreview = () => {
    const td = Number($<HTMLSelectElement>("edit-type").value);
    const rs = Number($<HTMLSelectElement>("edit-rarity-sub").value);
    const preview = document.getElementById("edit-icon-preview");
    if (preview) preview.innerHTML = moduleIconHtml(buildConfigId(td, rs));
  };
  $<HTMLSelectElement>("edit-type").onchange = updateIconPreview;
  $<HTMLSelectElement>("edit-rarity-sub").onchange = updateIconPreview;

  // Add stat
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

  // Remove stat
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
    const options = ALL_STAT_IDS.map((id) =>
      `<option value="${id}">${statName(id)}</option>`
    ).join("");
    const valueOpts = Array.from({ length: 10 }, (_, v) => v + 1)
      .map((v) => `<option value="${v}">　${v}</option>`)
      .join("");
    statRows.push(`<div class="stat-input-group" data-si="${i}">
      <select class="opt-select manual-stat-name">${i === 0 ? "" : ""}<option value="">-- 選択 --</option>${options}</select>
      <select class="opt-select manual-stat-value">${valueOpts}</select>
      ${i > 0 ? `<button class="ocr-stat-remove manual-remove-stat" data-si="${i}">&times;</button>` : ""}
    </div>`);
  }

  body.innerHTML = `<div class="manual-form">
    <div class="form-row">
      <label class="form-field">
        <span class="cmd-lbl">型</span>
        <select class="opt-select" id="manual-type">
          <option value="1">攻撃</option>
          <option value="2">支援</option>
          <option value="3">防御</option>
        </select>
      </label>
      <label class="form-field">
        <span class="cmd-lbl">レア種別</span>
        <select class="opt-select" id="manual-rarity-sub">
          <option value="1">青</option>
          <option value="2">紫</option>
          <option value="3">金A</option>
          <option value="4">金B</option>
        </select>
      </label>
    </div>
    <div class="manual-stats-section">
      <div class="cmd-lbl">ステータス</div>
      <div id="manual-stat-rows">${statRows.join("")}</div>
      ${manualStatCount < 3 ? `<button class="addbtn" id="manual-add-stat">+ ステータス追加</button>` : ""}
    </div>
  </div>`;

  // Bind add stat
  const addBtn = document.getElementById("manual-add-stat");
  if (addBtn) addBtn.onclick = () => { manualStatCount++; renderManualModalBody(); };

  // Bind remove stat
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
      showToast("ステータスが重複しています", "error");
      return;
    }
    usedIds.add(partId);

    stats.push({ part_id: partId, value: Number(valueSelect.value) });
  }

  if (stats.length === 0) {
    showToast("ステータスを1つ以上入力してください", "error");
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
  showToast("モジュールを追加しました", "success");

  // Reset form for next input
  manualStatCount = 1;
  renderManualModalBody();
}

// ========== Screenshot Import ==========

function importScreenshot() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;
  input.addEventListener("change", async () => {
    const files = input.files;
    if (!files || files.length === 0) return;

    // ファイル選択直後にローディング表示（タブ+コンテンツ全体を覆う）
    const btn = $<HTMLButtonElement>("screenshot-btn");
    btn.classList.add("loading");
    btn.textContent = "読み取り中...";
    const overlay = createLoadingOverlay();
    const appEl = document.querySelector(".app")!;
    const statusbar = appEl.querySelector(".statusbar")!;
    appEl.insertBefore(overlay, statusbar);

    const groups: OcrGroup[] = [];

    const progress = $("sb-progress");
    const total = files.length;
    progress.textContent = `取り込み中（0/${total}）`;
    progress.style.display = "";

    try {
      for (let fi = 0; fi < files.length; fi++) {
        const file = files[fi];
        const imageUrl = URL.createObjectURL(file);
        const img = new Image();
        img.src = imageUrl;
        await new Promise((resolve) => (img.onload = resolve));
        try {
          const detected = await processScreenshot(img);
          if (detected.length > 0) {
            groups.push({ imageUrl, modules: detected });
          } else {
            URL.revokeObjectURL(imageUrl);
          }
        } catch {
          URL.revokeObjectURL(imageUrl);
          throw new Error("スクショの読み取りに失敗しました");
        }
        progress.textContent = `取り込み中（${fi + 1}/${total}）`;
      }

      overlay.remove();
      btn.classList.remove("loading");
      btn.textContent = "スクショ取込";
      progress.style.display = "none";
      if (groups.length === 0) {
        showToast("モジュールを検出できませんでした", "error");
      } else {
        openOcrConfirmationModal(groups);
      }
    } catch (err) {
      overlay.remove();
      btn.classList.remove("loading");
      btn.textContent = "スクショ取込";
      progress.style.display = "none";
      showToast(err instanceof Error ? err.message : "スクショの読み取りに失敗しました", "error");
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
    $("clear-btn").textContent = "本当に削除？";
    $("clear-btn").classList.add("has-items");
    setTimeout(() => {
      clearPending = false;
      $("clear-btn").textContent = "クリア";
      $("clear-btn").classList.remove("has-items");
    }, 3000);
    return;
  }
  clearPending = false;
  modules = [];
  localStorage.removeItem("modules");
  $("clear-btn").textContent = "クリア";
  $("clear-btn").classList.remove("has-items");
  renderGrid();
  updateOptRunBtn();
  showToast("モジュールをクリアしました", "success");
}

// ========== Toast ==========

function showToast(msg: string, type: "success" | "error" = "success") {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.style.display = "block";
  setTimeout(() => (el.style.display = "none"), 4000);
}

// ========== Init ==========

// ========== ページ全体のピンチズーム禁止（iOS WebKit対策） ==========

document.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false } as any);
document.addEventListener("gesturechange", (e) => e.preventDefault(), { passive: false } as any);
document.addEventListener("gestureend", (e) => e.preventDefault(), { passive: false } as any);
document.addEventListener("dblclick", (e) => e.preventDefault());

// ダブルタップズーム防止（iOS WebKit は touchend の間隔で判定する）
let lastTouchEnd = 0;
document.addEventListener("touchend", (e) => {
  const now = Date.now();
  if (now - lastTouchEnd <= 300) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });

document.addEventListener("touchmove", (e) => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

// ========== 画像ピンチズーム（要素単位） ==========

function setupImagePinchZoom(container: HTMLElement, gi: number) {
  const img = container.querySelector("img");
  if (!img) return;

  // 保存済みのズーム状態を復元
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

  // 1本指パン用
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
    if (scale <= 1) {
      translateX = 0;
      translateY = 0;
      return;
    }
    const rect = container.getBoundingClientRect();
    const imgW = img!.naturalWidth * (rect.width / img!.naturalWidth) * scale;
    const imgH = img!.naturalHeight * (rect.width / img!.naturalWidth) * scale;
    const maxX = 0;
    const minX = rect.width - imgW;
    const maxY = 0;
    const minY = rect.height - imgH;
    translateX = Math.min(maxX, Math.max(minX, translateX));
    translateY = Math.min(maxY, Math.max(minY, translateY));
  }

  function getTouchDistance(t1: Touch, t2: Touch) {
    return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
  }

  function getTouchMid(t1: Touch, t2: Touch, rect: DOMRect) {
    return {
      x: (t1.clientX + t2.clientX) / 2 - rect.left,
      y: (t1.clientY + t2.clientY) / 2 - rect.top,
    };
  }

  container.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      e.stopPropagation();
      isPanning = false;
      startDistance = getTouchDistance(e.touches[0], e.touches[1]);
      startScale = scale;
      const rect = container.getBoundingClientRect();
      const mid = getTouchMid(e.touches[0], e.touches[1], rect);
      startMidX = mid.x;
      startMidY = mid.y;
      startTranslateX = translateX;
      startTranslateY = translateY;
    } else if (e.touches.length === 1 && scale > 1) {
      // 拡大中のみ1本指パンを有効にする
      isPanning = true;
      panStartX = e.touches[0].clientX;
      panStartY = e.touches[0].clientY;
      panStartTranslateX = translateX;
      panStartTranslateY = translateY;
    }
  }, { passive: false });

  container.addEventListener("touchmove", (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      e.stopPropagation();
      const currentDistance = getTouchDistance(e.touches[0], e.touches[1]);
      const newScale = Math.min(5, Math.max(1, startScale * (currentDistance / startDistance)));

      // ピンチ中心を基準にズーム
      const rect = container.getBoundingClientRect();
      const mid = getTouchMid(e.touches[0], e.touches[1], rect);
      const scaleRatio = newScale / startScale;
      translateX = mid.x - (startMidX - startTranslateX) * scaleRatio;
      translateY = mid.y - (startMidY - startTranslateY) * scaleRatio;
      scale = newScale;

      clampTranslate();
      applyTransform();
    } else if (e.touches.length === 1 && isPanning && scale > 1) {
      e.preventDefault();
      e.stopPropagation();
      translateX = panStartTranslateX + (e.touches[0].clientX - panStartX);
      translateY = panStartTranslateY + (e.touches[0].clientY - panStartY);
      clampTranslate();
      applyTransform();
    }
  }, { passive: false });

  container.addEventListener("touchend", (e) => {
    if (e.touches.length === 0) {
      isPanning = false;
      if (scale < 1.05) {
        scale = 1;
        translateX = 0;
        translateY = 0;
        applyTransform();
      }
    }
  });

  // ダブルタップでリセット
  let lastTap = 0;
  container.addEventListener("touchend", (e) => {
    if (e.touches.length !== 0) return;
    const now = Date.now();
    if (now - lastTap < 300) {
      scale = 1;
      translateX = 0;
      translateY = 0;
      applyTransform();
    }
    lastTap = now;
  });
}

document.addEventListener("DOMContentLoaded", () => {
  loadModulesFromStorage();

  // Tabs
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      $("panel-" + t.dataset.tab!).classList.add("active");
    };
  });

  // Filter
  $("filter-btn").onclick = (e) => openFilterMultiFly(e.currentTarget as HTMLElement);

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
      { label: "レアリティ", val: "rarity", disabled: ex.has("rarity") },
      { label: "合計値", val: "total", disabled: ex.has("total") },
    ];
    const statItems = ALL_STAT_NAMES.map((s) => ({ label: s, val: s, disabled: ex.has(s) }));
    openFly("fly-s", e.currentTarget as HTMLElement, [...extraItems, ...statItems], (it) => {
      sortKeys.push({ k: it.val, d: 1 });
      renderSChips();
      renderGrid();
    });
  };

  // Backdrop
  $("bd").onclick = closeFly;

  // Optimizer panel
  $("opt-btn-req").onclick = (e) => openOptMultiFly(e.currentTarget as HTMLElement, "req");
  $("opt-btn-des").onclick = (e) => openOptMultiFly(e.currentTarget as HTMLElement, "des");
  $("opt-btn-excl").onclick = (e) => openOptMultiFly(e.currentTarget as HTMLElement, "excl");
  $("opt-quality").onchange = () => { minQuality = Number($<HTMLSelectElement>("opt-quality").value); saveOptState(); };
  $("opt-run").onclick = () => runOptimize();

  // Pattern management
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
    $("patdel-msg").textContent = `パターン「${p.name}」を削除しますか？`;
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

  // Result modal
  $("modal-close").onclick = closeModal;
  $("modal-bd").onclick = (e) => { if (e.target === $("modal-bd")) closeModal(); };

  // OCR modal (backdrop click does NOT close)
  $("ocr-register").onclick = registerOcrModules;
  $("ocr-cancel").onclick = closeOcrModal;
  $("ocr-modal-close").onclick = closeOcrModal;
  // Manual input modal
  $("manual-btn").onclick = () => openManualInputModal();
  $("manual-modal-close").onclick = closeManualModal;
  $("manual-cancel").onclick = closeManualModal;
  $("manual-add").onclick = addManualModule;
  $("manual-modal-bd").onclick = (e) => { if (e.target === $("manual-modal-bd")) closeManualModal(); };

  // Edit module modal
  $("edit-modal-close").onclick = closeEditModal;
  $("edit-cancel").onclick = closeEditModal;
  $("edit-save").onclick = saveEditModule;
  $("edit-delete").onclick = deleteEditModule;
  $("edit-modal-bd").onclick = (e) => { if (e.target === $("edit-modal-bd")) closeEditModal(); };

  // Header buttons
  $("screenshot-btn").onclick = () => importScreenshot();
  $("clear-btn").onclick = () => clearModules();

  // Restore optimizer state
  restoreOptState();
  updateOptBtnLabel("req");
  updateOptBtnLabel("des");
  updateOptBtnLabel("excl");
  updateOptRunBtn();
  updateFilterBtnLabel();
  renderSChips();
  renderGrid();
});
