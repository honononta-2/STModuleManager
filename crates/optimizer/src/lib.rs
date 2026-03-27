#[cfg(feature = "parallel")]
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

// --- 共有型 ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatEntry {
    pub part_id: i64,
    pub value: i64,
}

/// 最適化に必要な最小限のモジュールデータ
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleInput {
    pub uuid: i64,
    pub quality: Option<u64>,
    pub stats: Vec<StatEntry>,
}

// --- スコアリング定数 ---
const BP_THRESHOLDS: [(i64, f64); 6] = [
    (20, 10000.0),
    (16, 5000.0),
    (12, 100.0),
    (8, 50.0),
    (4, 20.0),
    (1, 5.0),
];
const DESIRED_WEIGHT: f64 = 0.3;
const OTHER_WEIGHT: f64 = 0.5; // 貢献度フィルタリング用
const NON_SELECTED_BP_WEIGHT: f64 = 0.15; // 非選択のBPスコア重み（サブの半分）
const PLUS_BONUS_MULTIPLIER: f64 = 2.0;

// --- 最適化リクエスト/レスポンス ---

#[derive(Debug, Clone, Deserialize)]
pub struct OptimizeRequest {
    pub required_stats: Vec<i64>,
    pub desired_stats: Vec<i64>,
    pub excluded_stats: Vec<i64>,
    pub min_quality: u64,
    /// Web Worker分割用: このWorkerのID (0-based)
    #[serde(default)]
    pub worker_id: Option<usize>,
    /// Web Worker分割用: 総Worker数
    #[serde(default)]
    pub num_workers: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OptimizeResponse {
    pub combinations: Vec<Combination>,
    pub filtered_count: usize,
    pub total_modules: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Combination {
    pub rank: usize,
    pub modules: Vec<CombinationModule>,
    pub stat_totals: Vec<StatTotal>,
    pub score: f64,
    pub total_plus: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CombinationModule {
    pub uuid: i64,
    pub quality: Option<u64>,
    pub stats: Vec<StatEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatTotal {
    pub part_id: i64,
    pub total: i64,
    pub breakpoint: String,
    pub breakpoint_score: f64,
    pub is_required: bool,
    pub is_desired: bool,
}

// --- 内部用フラット構造 ---

struct ModuleFlat {
    index: usize,
    stats: Vec<(i64, i64)>,
    contribution: f64,
}

// --- 公開API ---

pub fn optimize(modules: &[ModuleInput], req: &OptimizeRequest) -> OptimizeResponse {
    let total_modules = modules.len();

    let required_set: std::collections::HashSet<i64> =
        req.required_stats.iter().copied().collect();
    let desired_set: std::collections::HashSet<i64> =
        req.desired_stats.iter().copied().collect();
    let excluded_set: std::collections::HashSet<i64> =
        req.excluded_stats.iter().copied().collect();

    let is_relevant = |part_id: i64| -> bool {
        required_set.contains(&part_id) || desired_set.contains(&part_id)
    };

    // --- Stage 1: 関連性フィルタ ---
    let mut candidates: Vec<(usize, &ModuleInput)> = modules
        .iter()
        .enumerate()
        .filter(|(_, m)| m.stats.iter().any(|s| is_relevant(s.part_id)))
        .collect();

    // --- Stage 2: レアリティフィルタ ---
    candidates.retain(|(_, m)| m.quality.unwrap_or(0) >= req.min_quality);

    // --- Stage 3: 貢献度スコア Top N ---
    let mut flats: Vec<ModuleFlat> = candidates
        .iter()
        .map(|(idx, m)| {
            let all_stats: Vec<(i64, i64)> = m
                .stats
                .iter()
                .map(|s| (s.part_id, s.value))
                .collect();

            let contribution: f64 = all_stats
                .iter()
                .map(|(pid, val)| {
                    let w = if excluded_set.contains(pid) {
                        0.0
                    } else if required_set.contains(pid) {
                        3.0
                    } else if desired_set.contains(pid) {
                        1.0
                    } else {
                        OTHER_WEIGHT
                    };
                    *val as f64 * w
                })
                .sum();

            ModuleFlat {
                index: *idx,
                stats: all_stats,
                contribution,
            }
        })
        .collect();

    flats.sort_by(|a, b| b.contribution.partial_cmp(&a.contribution).unwrap());

    const TOP_N: usize = 300;
    if flats.len() > TOP_N {
        flats.truncate(TOP_N);
    }

    let filtered_count = flats.len();

    if filtered_count < 4 {
        return OptimizeResponse {
            combinations: vec![],
            filtered_count,
            total_modules,
        };
    }

    // --- 探索用データ準備 ---
    let mut all_part_ids: Vec<i64> = flats
        .iter()
        .flat_map(|f| f.stats.iter().map(|(pid, _)| *pid))
        .collect();
    all_part_ids.sort();
    all_part_ids.dedup();
    let pid_to_idx: std::collections::HashMap<i64, usize> = all_part_ids
        .iter()
        .enumerate()
        .map(|(i, &pid)| (pid, i))
        .collect();
    let stat_count = all_part_ids.len();

    let stat_arrays: Vec<Vec<i64>> = flats
        .iter()
        .map(|f| {
            let mut arr = vec![0i64; stat_count];
            for &(pid, val) in &f.stats {
                if let Some(&idx) = pid_to_idx.get(&pid) {
                    arr[idx] = val;
                }
            }
            arr
        })
        .collect();

    let score_stats = |totals: &[i64]| -> f64 {
        let mut score = 0.0f64;
        let mut total_plus = 0i64;
        for (si, &total) in totals.iter().enumerate() {
            let pid = all_part_ids[si];

            total_plus += total; // 全ステータスの合計 × 2

            // 除外はBPスコアのみ0
            if excluded_set.contains(&pid) {
                continue;
            }

            let is_req = required_set.contains(&pid);
            let is_des = desired_set.contains(&pid);

            // BPスコア重み: メイン×1.0 / サブ×0.3 / 非選択×0.15
            let weight = if is_req {
                1.0
            } else if is_des {
                DESIRED_WEIGHT
            } else {
                NON_SELECTED_BP_WEIGHT
            };

            for &(threshold, points) in &BP_THRESHOLDS {
                if total >= threshold {
                    score += points * weight;
                    break;
                }
            }
        }
        score += total_plus as f64 * PLUS_BONUS_MULTIPLIER;
        score
    };

    // --- 4重ループ探索 ---
    let n = filtered_count;
    let top_k = 10usize;

    // Worker分割: 外側ループの担当範囲を決定
    let (range_start, range_end) = match (req.worker_id, req.num_workers) {
        (Some(id), Some(total)) if total > 0 => {
            let chunk = n / total;
            let start = id * chunk;
            let end = if id == total - 1 { n } else { start + chunk };
            (start, end)
        }
        _ => (0, n),
    };

    let global_best = Mutex::new(BoundedHeap::new(top_k));

    let search_from_i = |i: usize| {
        let mut local_best = BoundedHeap::new(top_k);
        let si = &stat_arrays[i];

        let mut partial2 = vec![0i64; stat_count];
        let mut partial3 = vec![0i64; stat_count];
        let mut totals_buf = vec![0i64; stat_count];
        let mut ub_buf = vec![0i64; stat_count];

        let mut cached_global_threshold = f64::NEG_INFINITY;
        let mut j_count = 0u32;

        for j in (i + 1)..n {
            let sj = &stat_arrays[j];
            for s in 0..stat_count {
                partial2[s] = si[s] + sj[s];
            }

            j_count += 1;
            if j_count % 64 == 0 {
                cached_global_threshold = global_best.lock().unwrap().min_score();
            }

            let local_threshold = if local_best.is_full() {
                local_best.min_score().max(cached_global_threshold)
            } else {
                cached_global_threshold
            };

            if local_threshold > f64::NEG_INFINITY {
                for s in 0..stat_count {
                    ub_buf[s] = partial2[s] + 20;
                }
                if score_stats(&ub_buf) < local_threshold {
                    continue;
                }
            }

            for k in (j + 1)..n {
                let sk = &stat_arrays[k];
                for s in 0..stat_count {
                    partial3[s] = partial2[s] + sk[s];
                }

                for l in (k + 1)..n {
                    let sl = &stat_arrays[l];
                    for s in 0..stat_count {
                        totals_buf[s] = partial3[s] + sl[s];
                    }
                    let sc = score_stats(&totals_buf);
                    local_best.push(sc, [i, j, k, l]);
                }
            }
        }

        let mut g = global_best.lock().unwrap();
        for entry in local_best.entries {
            g.push(entry.score, entry.indices);
        }
    };

    #[cfg(feature = "parallel")]
    {
        let num_threads = std::thread::available_parallelism()
            .map(|p| (p.get() * 3 / 4).max(1))
            .unwrap_or(4);
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(num_threads)
            .build()
            .unwrap();
        pool.install(|| {
            (range_start..range_end).into_par_iter().for_each(|i| search_from_i(i));
        });
    }

    #[cfg(not(feature = "parallel"))]
    {
        for i in range_start..range_end {
            search_from_i(i);
        }
    }

    // --- 結果組み立て ---
    let heap = global_best.into_inner().unwrap();
    let mut results: Vec<(f64, [usize; 4])> = heap
        .entries
        .into_iter()
        .map(|e| (e.score, e.indices))
        .collect();
    results.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());

    let combinations: Vec<Combination> = results
        .iter()
        .enumerate()
        .map(|(rank, (score, indices))| {
            let totals: Vec<i64> = (0..stat_count)
                .map(|si| {
                    indices
                        .iter()
                        .map(|&idx| stat_arrays[idx][si])
                        .sum::<i64>()
                })
                .collect();

            let stat_totals: Vec<StatTotal> = all_part_ids
                .iter()
                .enumerate()
                .filter(|(si, _)| totals[*si] > 0)
                .map(|(si, &pid)| {
                    let total = totals[si];
                    let is_req = required_set.contains(&pid);
                    let is_des = desired_set.contains(&pid);

                    let (bp_label, bp_score) = if is_req || is_des {
                        let weight = if is_req { 1.0 } else { DESIRED_WEIGHT };
                        BP_THRESHOLDS
                            .iter()
                            .find(|(th, _)| total >= *th)
                            .map(|(th, pts)| (format!("+{}到達", th), *pts * weight))
                            .unwrap_or(("未到達".to_string(), 0.0))
                    } else {
                        ("—".to_string(), 0.0)
                    };

                    StatTotal {
                        part_id: pid,
                        total,
                        breakpoint: bp_label,
                        breakpoint_score: bp_score,
                        is_required: is_req,
                        is_desired: is_des,
                    }
                })
                .collect();

            let total_plus: i64 = totals.iter().sum();

            let comb_modules: Vec<CombinationModule> = indices
                .iter()
                .map(|&idx| {
                    let orig = &modules[flats[idx].index];
                    CombinationModule {
                        uuid: orig.uuid,
                        quality: orig.quality,
                        stats: orig.stats.clone(),
                    }
                })
                .collect();

            Combination {
                rank: rank + 1,
                modules: comb_modules,
                stat_totals,
                score: *score,
                total_plus,
            }
        })
        .collect();

    OptimizeResponse {
        combinations,
        filtered_count,
        total_modules,
    }
}

// --- Top-K ヒープ ---

struct HeapEntry {
    score: f64,
    indices: [usize; 4],
}

struct BoundedHeap {
    entries: Vec<HeapEntry>,
    capacity: usize,
}

impl BoundedHeap {
    fn new(capacity: usize) -> Self {
        Self {
            entries: Vec::with_capacity(capacity + 1),
            capacity,
        }
    }

    fn min_score(&self) -> f64 {
        if self.entries.len() < self.capacity {
            f64::NEG_INFINITY
        } else {
            self.entries
                .iter()
                .map(|e| e.score)
                .fold(f64::INFINITY, f64::min)
        }
    }

    fn is_full(&self) -> bool {
        self.entries.len() >= self.capacity
    }

    fn push(&mut self, score: f64, indices: [usize; 4]) {
        if self.entries.len() < self.capacity {
            self.entries.push(HeapEntry { score, indices });
        } else {
            let min_idx = self
                .entries
                .iter()
                .enumerate()
                .min_by(|(_, a), (_, b)| a.score.partial_cmp(&b.score).unwrap())
                .map(|(i, _)| i)
                .unwrap();
            if score > self.entries[min_idx].score {
                self.entries[min_idx] = HeapEntry { score, indices };
            }
        }
    }
}
