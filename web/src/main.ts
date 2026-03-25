import { STAT_NAMES, ALL_STAT_IDS, statName } from "@shared/stats";
import type {
  Combination,
  ModuleInput,
  OptimizeRequest,
  OptimizeResponse,
  StatEntry,
} from "@shared/types";
import { processScreenshot } from "./ocr";
import "./style.css";

// --- State ---
let modules: ModuleInput[] = [];
let optRequired: number[] = [];
let optDesired: number[] = [];
let optExcluded: number[] = [];
let minQuality = 3;

// --- Multi Web Worker ---
const numWorkers = Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 2));

const workers: Worker[] = [];
for (let i = 0; i < numWorkers; i++) {
  workers.push(
    new Worker(new URL("./wasm-worker.ts", import.meta.url), { type: "module" }),
  );
}

// --- UI Setup ---
document.addEventListener("DOMContentLoaded", () => {
  loadModulesFromStorage();
  renderModuleCount();
  setupStatSelectors();
  setupControls();
});

function setupStatSelectors() {
  renderStatButtons("req-stats", optRequired, (ids) => {
    optRequired = ids;
  });
  renderStatButtons("des-stats", optDesired, (ids) => {
    optDesired = ids;
  });
  renderStatButtons("excl-stats", optExcluded, (ids) => {
    optExcluded = ids;
  });
}

function renderStatButtons(
  containerId: string,
  selected: number[],
  onUpdate: (ids: number[]) => void,
) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";
  for (const id of ALL_STAT_IDS) {
    const btn = document.createElement("button");
    btn.className = "stat-btn" + (selected.includes(id) ? " active" : "");
    btn.textContent = statName(id);
    btn.addEventListener("click", () => {
      const idx = selected.indexOf(id);
      if (idx >= 0) {
        selected.splice(idx, 1);
      } else {
        selected.push(id);
      }
      btn.classList.toggle("active");
      onUpdate([...selected]);
      updateRunButton();
    });
    container.appendChild(btn);
  }
}

function setupControls() {
  const qualitySelect = document.getElementById(
    "quality-select",
  ) as HTMLSelectElement;
  qualitySelect?.addEventListener("change", () => {
    minQuality = Number(qualitySelect.value);
  });

  document.getElementById("run-btn")?.addEventListener("click", runOptimize);
  document
    .getElementById("import-btn")
    ?.addEventListener("click", importModules);
  document
    .getElementById("screenshot-btn")
    ?.addEventListener("click", importScreenshot);
  document.getElementById("clear-btn")?.addEventListener("click", clearModules);
  updateRunButton();
}

function updateRunButton() {
  const btn = document.getElementById("run-btn") as HTMLButtonElement;
  if (btn) {
    btn.disabled = optRequired.length === 0 || modules.length < 4;
  }
}

// --- Optimize ---
function runOptimize() {
  setRunning(true);

  let completed = 0;
  let errored = false;
  const allCombinations: Combination[] = [];
  let filteredCount = 0;
  let totalModules = 0;

  for (let i = 0; i < numWorkers; i++) {
    const req: OptimizeRequest = {
      required_stats: optRequired,
      desired_stats: optDesired,
      excluded_stats: optExcluded,
      min_quality: minQuality,
      worker_id: i,
      num_workers: numWorkers,
    };

    workers[i].onmessage = (e: MessageEvent) => {
      const { type, data, error } = e.data;
      if (errored) return;

      if (type === "error") {
        errored = true;
        showError(error);
        setRunning(false);
        return;
      }

      if (type === "result") {
        const res = data as OptimizeResponse;
        allCombinations.push(...res.combinations);
        filteredCount = res.filtered_count;
        totalModules = res.total_modules;
        completed++;

        if (completed === numWorkers) {
          // 全Workerの結果をマージ: スコア降順ソート → Top 10
          allCombinations.sort((a, b) => b.score - a.score);
          const top10 = allCombinations.slice(0, 10).map((c, idx) => ({
            ...c,
            rank: idx + 1,
          }));
          renderResults({
            combinations: top10,
            filtered_count: filteredCount,
            total_modules: totalModules,
          });
          setRunning(false);
        }
      }
    };

    workers[i].postMessage({ type: "optimize", modules, request: req });
  }
}

function setRunning(running: boolean) {
  const btn = document.getElementById("run-btn") as HTMLButtonElement;
  const indicator = document.getElementById("running-indicator");
  if (btn) btn.disabled = running;
  if (indicator) indicator.style.display = running ? "block" : "none";
}

// --- Results ---
function renderResults(res: OptimizeResponse) {
  const container = document.getElementById("results")!;
  const empty = document.getElementById("empty-state")!;

  if (res.combinations.length === 0) {
    container.innerHTML = "";
    empty.style.display = "block";
    empty.textContent = "条件に合う組み合わせが見つかりませんでした";
    return;
  }

  empty.style.display = "none";
  container.innerHTML = res.combinations
    .map(
      (c) => `
    <div class="combo-card">
      <div class="combo-rank">#${c.rank}</div>
      <div class="combo-score">スコア: ${c.score.toFixed(1)} / 合計+値: ${c.total_plus}</div>
      <div class="combo-stats">
        ${c.stat_totals
          .map(
            (s) => `
          <span class="stat-chip ${s.is_required ? "required" : ""}">
            ${statName(s.part_id)} +${s.total} ${s.breakpoint}
          </span>
        `,
          )
          .join("")}
      </div>
      <div class="combo-modules">
        ${c.modules
          .map(
            (m) => `
          <div class="mod-item">
            <span class="mod-quality q${m.quality ?? 0}">★${m.quality ?? "?"}</span>
            ${m.stats.map((s) => `<span class="mod-stat">${statName(s.part_id)}+${s.value}</span>`).join("")}
          </div>
        `,
          )
          .join("")}
      </div>
    </div>
  `,
    )
    .join("");
}

// --- Screenshot Import ---
function importScreenshot() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.capture = "environment"; // スマホではカメラ起動
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;

    const img = new Image();
    img.src = URL.createObjectURL(file);
    await new Promise((resolve) => (img.onload = resolve));

    const progressEl = document.getElementById("ocr-progress");
    if (progressEl) progressEl.style.display = "block";

    try {
      const detected = await processScreenshot(img, (p) => {
        if (progressEl) progressEl.textContent = p.stage;
      });

      URL.revokeObjectURL(img.src);

      if (detected.length === 0) {
        showError("モジュールを検出できませんでした");
        return;
      }

      // 検出したモジュールを追加
      modules.push(...detected);
      saveModulesToStorage();
      renderModuleCount();
      updateRunButton();
      showError(`${detected.length} 件のモジュールを検出しました`); // toast流用
    } catch (err) {
      showError(
        err instanceof Error ? err.message : "スクショの読み取りに失敗しました",
      );
    } finally {
      if (progressEl) progressEl.style.display = "none";
    }
  });
  input.click();
}

// --- Module Import (JSON) ---
function importModules() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);

      // Desktop版のmodules_db.json形式に対応
      if (data.modules && typeof data.modules === "object") {
        modules = Object.values(
          data.modules as Record<string, ModuleInput>,
        ).map(toModuleInput);
      } else if (Array.isArray(data)) {
        modules = data.map(toModuleInput);
      } else {
        throw new Error("不明なJSON形式です");
      }

      saveModulesToStorage();
      renderModuleCount();
      updateRunButton();
    } catch (err) {
      showError(
        err instanceof Error ? err.message : "JSONの読み込みに失敗しました",
      );
    }
  });
  input.click();
}

function toModuleInput(m: Record<string, unknown>): ModuleInput {
  return {
    uuid: (m.uuid as number) ?? 0,
    quality: (m.quality as number) ?? null,
    stats: ((m.stats as StatEntry[]) ?? []).map((s) => ({
      part_id: s.part_id,
      value: s.value,
    })),
  };
}

// --- Clear ---
function clearModules() {
  modules = [];
  localStorage.removeItem("modules");
  renderModuleCount();
  updateRunButton();
}

// --- Storage ---
function saveModulesToStorage() {
  try {
    localStorage.setItem("modules", JSON.stringify(modules));
  } catch {
    /* quota exceeded — ignore */
  }
}

function loadModulesFromStorage() {
  try {
    const saved = localStorage.getItem("modules");
    if (saved) modules = JSON.parse(saved);
  } catch {
    /* parse error — ignore */
  }
}

function renderModuleCount() {
  const el = document.getElementById("module-count");
  if (el) el.textContent = `${modules.length} モジュール`;
  renderModuleList();
}

function renderModuleList() {
  const section = document.getElementById("module-list-section");
  const container = document.getElementById("module-list");
  if (!section || !container) return;

  if (modules.length === 0) {
    section.style.display = "none";
    return;
  }

  section.style.display = "";
  container.innerHTML = modules
    .map(
      (m, i) => `
    <div class="mod-row">
      <span class="mod-idx">${i + 1}</span>
      <span class="mod-quality q${m.quality ?? 0}">★${m.quality ?? "?"}</span>
      <span class="mod-stats-list">
        ${m.stats.map((s) => `<span class="mod-stat">${statName(s.part_id)} +${s.value}</span>`).join("")}
      </span>
    </div>
  `,
    )
    .join("");
}

function showError(msg: string) {
  const el = document.getElementById("error-toast");
  if (el) {
    el.textContent = msg;
    el.style.display = "block";
    setTimeout(() => (el.style.display = "none"), 5000);
  }
}
