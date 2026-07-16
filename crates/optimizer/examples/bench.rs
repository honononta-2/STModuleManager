use star_optimizer::{optimize, ModuleInput, OptimizeRequest};
use std::collections::HashMap;
use std::time::Instant;

#[derive(serde::Deserialize)]
struct ModulesDb {
    modules: HashMap<String, ModuleInput>,
}

fn main() {
    let path = std::env::var("MODULES_DB_PATH")
        .unwrap_or_else(|_| r"C:\Users\marma\AppData\Roaming\STModuleManager\modules_db.json".to_string());
    let data = std::fs::read_to_string(&path).expect("modules_db.json を読み込めません");
    let db: ModulesDb = serde_json::from_str(&data).expect("パースに失敗しました");

    let modules: Vec<ModuleInput> = db.modules.into_values().collect();
    println!("モジュール数: {}", modules.len());

    let mut part_ids: Vec<i64> = modules
        .iter()
        .flat_map(|m| m.stats.iter().map(|s| s.part_id))
        .collect();
    part_ids.sort();
    part_ids.dedup();
    println!("ユニークpart_id数: {}", part_ids.len());

    let required_stats: Vec<i64> = part_ids.iter().take(3).copied().collect();
    let desired_stats: Vec<i64> = part_ids.iter().skip(3).take(3).copied().collect();

    for slot_count in [4usize, 5usize] {
        for speed_mode in ["standard", "precise", "most_precise", "exhaustive"] {
            let req = OptimizeRequest {
                required_stats: required_stats.clone(),
                desired_stats: desired_stats.clone(),
                excluded_stats: vec![],
                min_quality: 0,
                speed_mode: Some(speed_mode.to_string()),
                worker_id: None,
                num_workers: None,
                min_thresholds: None,
                count_only: None,
                slot_count: Some(slot_count),
            };
            let start = Instant::now();
            let resp = optimize(&modules, &req);
            let elapsed = start.elapsed();
            println!(
                "slot_count={slot_count} speed_mode={speed_mode:<13} filtered_count={:<6} elapsed={elapsed:?}",
                resp.filtered_count
            );
            if std::env::var("BENCH_VERIFY").is_ok() {
                for c in &resp.combinations {
                    let mut uuids: Vec<i64> = c.modules.iter().map(|m| m.uuid).collect();
                    uuids.sort();
                    println!("  rank={} score={:.6} uuids={:?}", c.rank, c.score, uuids);
                }
            }
        }
    }
}
