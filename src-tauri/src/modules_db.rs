use chrono::{NaiveDate, NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

pub use star_optimizer::StatEntry;

/// 既存の "YYYY-MM-DD" 形式と新しい "YYYY-MM-DDTHH:MM:SS" 形式の両方に対応
fn deserialize_datetime_compat<'de, D>(deserializer: D) -> Result<NaiveDateTime, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;
    let s = String::deserialize(deserializer)?;
    if let Ok(dt) = s.parse::<NaiveDateTime>() {
        return Ok(dt);
    }
    s.parse::<NaiveDate>()
        .map(|d| d.and_hms_opt(0, 0, 0).unwrap())
        .map_err(|e| D::Error::custom(e))
}

/// 永続化されるモジュール1件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleEntry {
    pub uuid: i64,
    pub config_id: Option<u64>,
    pub quality: Option<u64>,
    pub stats: Vec<StatEntry>,
    pub success_rate: Option<u64>,
    pub equipped_slot: Option<i64>,
    /// 初回検出日時（入手日時）
    #[serde(deserialize_with = "deserialize_datetime_compat")]
    pub acquired_date: NaiveDateTime,
}

/// JSONファイルに保存される全体構造
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModulesDb {
    pub modules: HashMap<String, ModuleEntry>,
}

impl ModulesDb {
    fn new() -> Self {
        Self {
            modules: HashMap::new(),
        }
    }
}

/// Tauri の State として管理
pub struct ModulesDbState {
    pub db: Mutex<ModulesDb>,
    pub path: PathBuf,
}

impl ModulesDbState {
    pub fn new(path: PathBuf) -> Self {
        let db = if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(content) => serde_json::from_str(&content).unwrap_or_else(|_| ModulesDb::new()),
                Err(_) => ModulesDb::new(),
            }
        } else {
            ModulesDb::new()
        };

        Self {
            db: Mutex::new(db),
            path,
        }
    }

    /// DBをファイルに保存
    pub fn save(&self) -> Result<(), String> {
        let db = self.db.lock().map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(&*db).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, json).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// キャプチャで取得したモジュール群をDBにマージする。
    /// 新規UUIDは現在日時を入手日時として追加。既存UUIDはステータスを更新。
    /// キャプチャに含まれないUUIDはDBから削除する。
    pub fn merge_modules(&self, raw_modules: &[serde_json::Value]) -> Result<usize, String> {
        let mut db = self.db.lock().map_err(|e| e.to_string())?;
        let now = Utc::now().naive_utc();
        let mut new_count = 0;

        // キャプチャに含まれるUUIDを収集
        let mut seen_keys = std::collections::HashSet::new();

        for raw in raw_modules {
            let uuid = raw.get("uuid").and_then(|v| v.as_i64()).unwrap_or(0);
            if uuid == 0 {
                continue;
            }
            let key = uuid.to_string();
            seen_keys.insert(key.clone());

            let config_id = raw.get("config_id").and_then(|v| v.as_u64());
            let quality = raw.get("quality").and_then(|v| v.as_u64());
            let success_rate = raw.get("success_rate").and_then(|v| v.as_u64());
            let equipped_slot = raw.get("equipped_slot").and_then(|v| v.as_i64());

            let stats = parse_stats(raw.get("stats"));

            let is_new = !db.modules.contains_key(&key);
            if is_new {
                new_count += 1;
            }

            let acquired_date = db
                .modules
                .get(&key)
                .map(|existing| existing.acquired_date)
                .unwrap_or(now);

            db.modules.insert(
                key,
                ModuleEntry {
                    uuid,
                    config_id,
                    quality,
                    stats,
                    success_rate,
                    equipped_slot,
                    acquired_date,
                },
            );
        }

        // キャプチャに含まれないモジュールを削除
        db.modules.retain(|key, _| seen_keys.contains(key));

        // メモリ上のDBを更新したのでロックを先に解放してからファイルに保存
        drop(db);
        self.save()?;

        Ok(new_count)
    }

    /// 単体モジュールを追加する（0x16 差分更新用）。新規なら true を返す。
    pub fn add_module(&self, uuid: i64, config_id: u64, quality: u64) -> Result<bool, String> {
        let mut db = self.db.lock().map_err(|e| e.to_string())?;
        let key = uuid.to_string();
        let now = Utc::now().naive_utc();

        let is_new = !db.modules.contains_key(&key);
        let acquired_date = db
            .modules
            .get(&key)
            .map(|e| e.acquired_date)
            .unwrap_or(now);

        db.modules.insert(
            key,
            ModuleEntry {
                uuid,
                config_id: Some(config_id),
                quality: Some(quality),
                stats: Vec::new(),
                success_rate: None,
                equipped_slot: None,
                acquired_date,
            },
        );

        drop(db);
        self.save()?;
        Ok(is_new)
    }

    /// モジュールのステータスを更新する（0x16 差分更新用）
    pub fn update_stats(
        &self,
        uuid: i64,
        stats: &[(i64, i64)],
        success_rate: u64,
    ) -> Result<(), String> {
        let mut db = self.db.lock().map_err(|e| e.to_string())?;
        let key = uuid.to_string();

        if let Some(entry) = db.modules.get_mut(&key) {
            entry.stats = stats
                .iter()
                .map(|(part_id, value)| StatEntry {
                    part_id: *part_id,
                    value: *value,
                })
                .collect();
            entry.success_rate = Some(success_rate);
        }

        drop(db);
        self.save()?;
        Ok(())
    }

    /// モジュールを削除する（0x16 差分更新用）。存在していれば true を返す。
    pub fn remove_module(&self, uuid: i64) -> Result<bool, String> {
        let mut db = self.db.lock().map_err(|e| e.to_string())?;
        let key = uuid.to_string();
        let existed = db.modules.remove(&key).is_some();
        drop(db);
        if existed {
            self.save()?;
        }
        Ok(existed)
    }
}

fn parse_stats(value: Option<&serde_json::Value>) -> Vec<StatEntry> {
    let arr = match value {
        Some(serde_json::Value::Array(arr)) => arr,
        _ => return Vec::new(),
    };
    arr.iter()
        .filter_map(|s| {
            let part_id = s.get("part_id").and_then(|v| v.as_i64())?;
            let value = s.get("value").and_then(|v| v.as_i64())?;
            Some(StatEntry { part_id, value })
        })
        .collect()
}
