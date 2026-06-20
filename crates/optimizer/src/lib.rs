#[cfg(feature = "parallel")]
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

// --- 共有型 ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
// BPスコア: カテゴリ別の固定点数テーブル（READMEの表と完全一致）
const BP_MAIN: [(i64, f64); 6] = [
    (20, 10000.0), (16, 5000.0), (12, 100.0), (8, 50.0), (4, 20.0), (1, 5.0),
];
const BP_SUB: [(i64, f64); 6] = [
    (20, 3000.0), (16, 1500.0), (12, 30.0), (8, 15.0), (4, 6.0), (1, 1.5),
];
const BP_NON_SELECTED: [(i64, f64); 6] = [
    (20, 1000.0), (16, 500.0), (12, 10.0), (8, 5.0), (4, 2.0), (1, 0.5),
];
// 貢献度フィルタリング用の重み
const CONTRIB_MAIN_WEIGHT: f64 = 3.0;
const CONTRIB_SUB_WEIGHT: f64 = 1.0;
const CONTRIB_OTHER_WEIGHT: f64 = 0.5;
const PLUS_BONUS_MULTIPLIER: f64 = 2.0;
// 1モジュールの1ステータスに乗りうる最大値
const MODULE_STAT_MAX_VALUE: usize = 10;

// --- 最適化リクエスト/レスポンス ---

#[derive(Debug, Clone, Deserialize)]
pub struct OptimizeRequest {
    pub required_stats: Vec<i64>,
    pub desired_stats: Vec<i64>,
    pub excluded_stats: Vec<i64>,
    pub min_quality: u64,
    /// 探索スピードモード: "standard"(200件) / "precise"(300件) / "most_precise"(600件)
    #[serde(default)]
    pub speed_mode: Option<String>,
    /// Web Worker分割用: このWorkerのID (0-based)
    #[serde(default)]
    pub worker_id: Option<usize>,
    /// Web Worker分割用: 総Worker数
    #[serde(default)]
    pub num_workers: Option<usize>,
    /// ステータス最低値制約: part_id → 最低合計値
    #[serde(default)]
    pub min_thresholds: Option<std::collections::HashMap<i64, i64>>,
    /// カウントのみモード: Stage1&2フィルタ後の候補数だけ返す（探索は行わない）
    #[serde(default)]
    pub count_only: Option<bool>,
    /// 装着枠数（選択するモジュール数）。未指定時は4
    #[serde(default)]
    pub slot_count: Option<usize>,
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

// totals に疎なステータスを加算し、スコアの増分を返す
fn add_delta(totals: &mut [u8], sp: &[(usize, u8)], bp_lookup: &[[f64; 21]]) -> f64 {
    let mut delta = 0.0f64;
    for &(idx, val) in sp {
        let before = totals[idx];
        let after = before + val;
        delta += bp_lookup[idx][(after as usize).min(20)]
            - bp_lookup[idx][(before as usize).min(20)];
        delta += val as f64 * PLUS_BONUS_MULTIPLIER;
        totals[idx] = after;
    }
    delta
}

// totals から疎なステータスを減算する
fn sub_sparse(totals: &mut [u8], sp: &[(usize, u8)]) {
    for &(idx, val) in sp {
        totals[idx] -= val;
    }
}

// 残り1枠で伸ばせる最大スコア（各ステータスの伸びのうち上位3つの合計）
fn remaining_gain(totals: &[u8], gain_lookup: &[[f64; 21]]) -> f64 {
    let (mut g1, mut g2, mut g3) = (0.0f64, 0.0f64, 0.0f64);
    for (si, &v) in totals.iter().enumerate() {
        let gain = gain_lookup[si][(v as usize).min(20)];
        if gain > g1 {
            g3 = g2;
            g2 = g1;
            g1 = gain;
        } else if gain > g2 {
            g3 = g2;
            g2 = gain;
        } else if gain > g3 {
            g3 = gain;
        }
    }
    g1 + g2 + g3
}

// 残り2枠（6スロット）で伸ばせる最大スコア
// 各ステータスに +0 / +10(1スロット) / +20(2スロット) を割り当て、6スロットでの増分を最大化する
fn remaining_gain_2(totals: &[u8], gain1_lookup: &[[f64; 21]], gain2_lookup: &[[f64; 21]]) -> f64 {
    // dp[c] = c スロット使ったときの最大増分
    let mut dp = [0.0f64; 7];
    for (si, &v) in totals.iter().enumerate() {
        let idx = (v as usize).min(20);
        let g1 = gain1_lookup[si][idx];
        let g2 = gain2_lookup[si][idx];
        for c in (1..=6).rev() {
            let mut best = dp[c];
            let with1 = dp[c - 1] + g1;
            if with1 > best {
                best = with1;
            }
            if c >= 2 {
                let with2 = dp[c - 2] + g2;
                if with2 > best {
                    best = with2;
                }
            }
            dp[c] = best;
        }
    }
    dp[6]
}

// 探索中に全枠で共有する読み取り専用データ
struct SearchCtx<'a> {
    n: usize,
    slot_count: usize,
    sparse: &'a [Vec<(usize, u8)>],
    bp_lookup: &'a [[f64; 21]],
    gain1_lookup: &'a [[f64; 21]],
    gain2_lookup: &'a [[f64; 21]],
    module_sum: &'a [f64],
    max_bp_sum: f64,
    stat_count: usize,
    threshold_constraints: &'a [(usize, u8)],
    global_best: &'a Mutex<BoundedHeap>,
}

// 残りの枠を1つずつ確定しながら組み合わせを探索する
fn search_rec(
    ctx: &SearchCtx,
    depth: usize,
    start: usize,
    base: f64,
    sum_acc: f64,
    totals: &mut [u8],
    indices: &mut [usize],
    local_best: &mut BoundedHeap,
    cached_global_threshold: &mut f64,
    counter: &mut u32,
) {
    let is_last = depth == ctx.slot_count - 1;

    for idx in start..ctx.n {
        let sp = &ctx.sparse[idx];
        let base_new = base + add_delta(totals, sp, ctx.bp_lookup);
        indices[depth] = idx;

        if is_last {
            // min_thresholds を満たさない組み合わせはスキップ
            let ok = ctx.threshold_constraints.is_empty()
                || ctx
                    .threshold_constraints
                    .iter()
                    .all(|&(ti, min_val)| totals[ti] >= min_val);
            if ok {
                local_best.push(base_new, indices.to_vec());
            }
            sub_sparse(totals, sp);
            continue;
        }

        // この枠を確定した後に残る枠数
        let remaining = ctx.slot_count - depth - 1;

        // 残り1枠・残り2枠でのみ枝刈りする
        if remaining <= 2 {
            *counter += 1;
            if *counter % 64 == 0 {
                *cached_global_threshold = ctx.global_best.lock().unwrap().min_score();
            }
            let local_threshold = if local_best.is_full() {
                local_best.min_score().max(*cached_global_threshold)
            } else {
                *cached_global_threshold
            };

            if local_threshold > f64::NEG_INFINITY {
                if remaining == 2 {
                    // 残り2枠が全ステータス+20に到達したと仮定した上界スコアでカット
                    let ub = ctx.max_bp_sum
                        + (sum_acc + ctx.module_sum[idx] + 20.0 * ctx.stat_count as f64)
                            * PLUS_BONUS_MULTIPLIER;
                    if ub < local_threshold {
                        sub_sparse(totals, sp);
                        continue;
                    }
                    // 残り2枠で伸ばせる最大スコアでカット
                    if base_new + remaining_gain_2(totals, ctx.gain1_lookup, ctx.gain2_lookup)
                        < local_threshold
                    {
                        sub_sparse(totals, sp);
                        continue;
                    }
                } else {
                    // 残り1枠で伸ばせる最大スコアでカット
                    if base_new + remaining_gain(totals, ctx.gain1_lookup) < local_threshold {
                        sub_sparse(totals, sp);
                        continue;
                    }
                }
            }
        }

        search_rec(
            ctx,
            depth + 1,
            idx + 1,
            base_new,
            sum_acc + ctx.module_sum[idx],
            totals,
            indices,
            local_best,
            cached_global_threshold,
            counter,
        );
        sub_sparse(totals, sp);
    }
}

// --- 公開API ---

pub fn optimize(modules: &[ModuleInput], req: &OptimizeRequest) -> OptimizeResponse {
    let total_modules = modules.len();
    let slot_count = req.slot_count.unwrap_or(4).max(2);

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

    // --- count_only モード: Stage1&2後の候補数だけ返す ---
    if req.count_only.unwrap_or(false) {
        return OptimizeResponse {
            combinations: vec![],
            filtered_count: candidates.len(),
            total_modules,
        };
    }

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
                        CONTRIB_MAIN_WEIGHT
                    } else if desired_set.contains(pid) {
                        CONTRIB_SUB_WEIGHT
                    } else {
                        CONTRIB_OTHER_WEIGHT
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

    let is_exhaustive = req.speed_mode.as_deref() == Some("exhaustive");
    if !is_exhaustive {
        let top_n: usize = match req.speed_mode.as_deref() {
            Some("precise") => 300,
            Some("most_precise") => 600,
            _ => 200, // "standard" またはデフォルト
        };
        if flats.len() > top_n {
            flats.truncate(top_n);
        }
    }

    let filtered_count = flats.len();

    if filtered_count < slot_count {
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

    // 各候補が持つ (stat_index, value) のみを保持する疎な表現
    let sparse: Vec<Vec<(usize, u8)>> = flats
        .iter()
        .map(|f| {
            let mut v: Vec<(usize, u8)> = f
                .stats
                .iter()
                .filter_map(|&(pid, val)| {
                    pid_to_idx
                        .get(&pid)
                        .map(|&idx| (idx, val.clamp(0, MODULE_STAT_MAX_VALUE as i64) as u8))
                })
                .collect();
            v.sort_by_key(|&(idx, _)| idx);
            v
        })
        .collect();

    // 各候補のステータス値の合計（上界スコアの定数項計算に使用）
    let module_sum: Vec<f64> = sparse
        .iter()
        .map(|sp| sp.iter().map(|&(_, val)| val as f64).sum())
        .collect();

    // ステータスインデックスごとのBPスコアルックアップテーブル（値0〜20→スコア）
    let bp_lookup: Vec<[f64; 21]> = (0..stat_count)
        .map(|si| {
            let pid = all_part_ids[si];
            let bp_table: &[(i64, f64)] = if excluded_set.contains(&pid) {
                &[]
            } else if required_set.contains(&pid) {
                &BP_MAIN
            } else if desired_set.contains(&pid) {
                &BP_SUB
            } else {
                &BP_NON_SELECTED
            };
            let mut table = [0.0f64; 21];
            for v in 0..=20usize {
                for &(th, pts) in bp_table {
                    if v as i64 >= th {
                        table[v] = pts;
                        break;
                    }
                }
            }
            table
        })
        .collect();

    // 全ステータスが+20到達した場合のBPスコア合計（上界スコアの定数項）
    let max_bp_sum: f64 = (0..stat_count).map(|si| bp_lookup[si][20]).sum();

    // 1ステータスを+10伸ばしたときのスコア増分（BP増分 + プラスボーナス分）
    let gain1_lookup: Vec<[f64; 21]> = bp_lookup
        .iter()
        .map(|bp| {
            let mut g = [0.0f64; 21];
            for v in 0..=20usize {
                g[v] = bp[(v + MODULE_STAT_MAX_VALUE).min(20)] - bp[v]
                    + MODULE_STAT_MAX_VALUE as f64 * PLUS_BONUS_MULTIPLIER;
            }
            g
        })
        .collect();

    // 1ステータスを+20伸ばしたときのスコア増分（同一ステータスに2モジュール分）
    let gain2_lookup: Vec<[f64; 21]> = bp_lookup
        .iter()
        .map(|bp| {
            let mut g = [0.0f64; 21];
            for v in 0..=20usize {
                g[v] = bp[(v + 2 * MODULE_STAT_MAX_VALUE).min(20)] - bp[v]
                    + 2.0 * MODULE_STAT_MAX_VALUE as f64 * PLUS_BONUS_MULTIPLIER;
            }
            g
        })
        .collect();

    // --- 4重ループ探索 ---
    let n = filtered_count;
    let top_k = 10usize;

    // Worker分割: インターリーブ方式で担当する i を決定
    let (worker_id, num_workers) = match (req.worker_id, req.num_workers) {
        (Some(id), Some(total)) if total > 1 => (id, total),
        _ => (0, 1),
    };

    // min_thresholds を探索用に変換: (stat_index, min_value) のペア
    let threshold_constraints: Vec<(usize, u8)> = req
        .min_thresholds
        .as_ref()
        .map(|thresholds| {
            thresholds
                .iter()
                .filter_map(|(pid, min_val)| {
                    pid_to_idx.get(pid).map(|&si| (si, *min_val as u8))
                })
                .collect()
        })
        .unwrap_or_default();

    let global_best = Mutex::new(BoundedHeap::new(top_k));

    let ctx = SearchCtx {
        n,
        slot_count,
        sparse: &sparse,
        bp_lookup: &bp_lookup,
        gain1_lookup: &gain1_lookup,
        gain2_lookup: &gain2_lookup,
        module_sum: &module_sum,
        max_bp_sum,
        stat_count,
        threshold_constraints: &threshold_constraints,
        global_best: &global_best,
    };

    let search_from_i = |i: usize| {
        let mut local_best = BoundedHeap::new(top_k);

        // 探索中に加減算で使い回す密バッファ
        let mut totals = vec![0u8; stat_count];
        // 確定した各枠のモジュール番号を保持する
        let mut indices = vec![0usize; slot_count];

        let si = &sparse[i];
        let base_i = add_delta(&mut totals, si, &bp_lookup);
        indices[0] = i;
        let sum_i = module_sum[i];

        let mut cached_global_threshold = f64::NEG_INFINITY;
        let mut counter = 0u32;

        search_rec(
            &ctx,
            1,
            i + 1,
            base_i,
            sum_i,
            &mut totals,
            &mut indices,
            &mut local_best,
            &mut cached_global_threshold,
            &mut counter,
        );

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
            (worker_id..n).into_par_iter().step_by(num_workers).for_each(|i| search_from_i(i));
        });
    }

    #[cfg(not(feature = "parallel"))]
    {
        let mut i = worker_id;
        while i < n {
            search_from_i(i);
            i += num_workers;
        }
    }

    // --- 結果組み立て ---
    let heap = global_best.into_inner().unwrap();
    let mut results: Vec<(f64, Vec<usize>)> = heap
        .entries
        .into_iter()
        .map(|e| (e.score, e.indices))
        .collect();
    results.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());

    let combinations: Vec<Combination> = results
        .iter()
        .enumerate()
        .map(|(rank, (score, indices))| {
            let mut totals = vec![0i64; stat_count];
            for &idx in indices.iter() {
                for &(si, val) in &sparse[idx] {
                    totals[si] += val as i64;
                }
            }

            let stat_totals: Vec<StatTotal> = all_part_ids
                .iter()
                .enumerate()
                .filter(|(si, _)| totals[*si] > 0)
                .map(|(si, &pid)| {
                    let total = totals[si];
                    let is_req = required_set.contains(&pid);
                    let is_des = desired_set.contains(&pid);

                    let (bp_label, bp_score) = if excluded_set.contains(&pid) {
                        ("—".to_string(), 0.0)
                    } else {
                        let bp_table = if is_req {
                            &BP_MAIN
                        } else if is_des {
                            &BP_SUB
                        } else {
                            &BP_NON_SELECTED
                        };
                        bp_table
                            .iter()
                            .find(|(th, _)| total >= *th)
                            .map(|(th, pts)| (format!("+{}到達", th), *pts))
                            .unwrap_or(("未到達".to_string(), 0.0))
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

    // --- 最低値制約フィルタリング ---
    let combinations = if let Some(ref thresholds) = req.min_thresholds {
        if !thresholds.is_empty() {
            combinations
                .into_iter()
                .filter(|comb| {
                    thresholds.iter().all(|(pid, min_val)| {
                        comb.stat_totals
                            .iter()
                            .find(|st| st.part_id == *pid)
                            .map(|st| st.total >= *min_val)
                            .unwrap_or(false)
                    })
                })
                .collect::<Vec<_>>()
        } else {
            combinations
        }
    } else {
        combinations
    };

    // フィルタ後の rank 振り直し
    let combinations: Vec<Combination> = combinations
        .into_iter()
        .enumerate()
        .map(|(i, mut c)| {
            c.rank = i + 1;
            c
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
    indices: Vec<usize>,
}

struct BoundedHeap {
    entries: Vec<HeapEntry>,
    capacity: usize,
    min_cached: f64,
}

impl BoundedHeap {
    fn new(capacity: usize) -> Self {
        Self {
            entries: Vec::with_capacity(capacity + 1),
            capacity,
            min_cached: f64::NEG_INFINITY,
        }
    }

    fn min_score(&self) -> f64 {
        self.min_cached
    }

    fn is_full(&self) -> bool {
        self.entries.len() >= self.capacity
    }

    fn recompute_min(&mut self) {
        self.min_cached = self
            .entries
            .iter()
            .map(|e| e.score)
            .fold(f64::INFINITY, f64::min);
    }

    fn push(&mut self, score: f64, indices: Vec<usize>) {
        if self.entries.len() < self.capacity {
            self.entries.push(HeapEntry { score, indices });
            if self.entries.len() == self.capacity {
                self.recompute_min();
            }
        } else if score > self.min_cached {
            let min_idx = self
                .entries
                .iter()
                .enumerate()
                .min_by(|(_, a), (_, b)| a.score.partial_cmp(&b.score).unwrap())
                .map(|(i, _)| i)
                .unwrap();
            self.entries[min_idx] = HeapEntry { score, indices };
            self.recompute_min();
        }
    }
}
