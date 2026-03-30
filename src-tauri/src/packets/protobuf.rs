/// スキーマなし Protobuf 生デコーダー
/// フィールド番号をキーとして serde_json::Value に変換する

use serde_json::{json, Value};

const MAX_DEPTH: usize = 10;

/// Protobuf バイナリペイロードを JSON にデコードする。
/// スキーマ不明のため、フィールド番号をキーとして出力する。
/// 同じフィールド番号が複数回出現した場合は配列にまとめる。
pub fn decode_protobuf_raw(data: &[u8]) -> Value {
    match decode_message(data, 0) {
        Some(v) => v,
        None => Value::Null,
    }
}

fn decode_message(data: &[u8], depth: usize) -> Option<Value> {
    if depth > MAX_DEPTH || data.is_empty() {
        return None;
    }

    let mut fields: Vec<(u32, Value)> = Vec::new();
    let mut pos = 0;

    while pos < data.len() {
        let (tag, new_pos) = read_varint(data, pos)?;
        pos = new_pos;

        let field_number = (tag >> 3) as u32;
        let wire_type = (tag & 0x7) as u8;

        if field_number == 0 || field_number > 536_870_911 {
            return None;
        }

        match wire_type {
            0 => {
                // Varint
                let (val, new_pos) = read_varint(data, pos)?;
                pos = new_pos;
                fields.push((field_number, json!(val)));
            }
            1 => {
                // 64-bit fixed
                if pos + 8 > data.len() {
                    return None;
                }
                let val = u64::from_le_bytes(data[pos..pos + 8].try_into().ok()?);
                pos += 8;
                fields.push((field_number, json!(val)));
            }
            2 => {
                // Length-delimited
                let (length, new_pos) = read_varint(data, pos)?;
                pos = new_pos;
                let length = length as usize;
                if length > data.len() - pos {
                    return None;
                }
                let chunk = &data[pos..pos + length];
                pos += length;

                // ネストされたメッセージとしてデコードを試みる
                // ただし packed varint が誤ってメッセージとして解釈されるケースがあるため、
                // デコード結果のフィールド番号が妥当な範囲かを検証する
                let value = if length > 4 {
                    if let Some(nested) = decode_message(chunk, depth + 1) {
                        if is_plausible_message(&nested) {
                            nested
                        } else {
                            decode_bytes_or_string(chunk)
                        }
                    } else {
                        decode_bytes_or_string(chunk)
                    }
                } else {
                    decode_bytes_or_string(chunk)
                };
                fields.push((field_number, value));
            }
            5 => {
                // 32-bit fixed
                if pos + 4 > data.len() {
                    return None;
                }
                let val = u32::from_le_bytes(data[pos..pos + 4].try_into().ok()?);
                pos += 4;
                fields.push((field_number, json!(val)));
            }
            _ => {
                // 不明なワイヤータイプ → パース失敗（ネストメッセージではない）
                return None;
            }
        }
    }

    if fields.is_empty() {
        return None;
    }

    // フィールド番号ごとにグループ化
    // 同じフィールド番号が複数 → 配列に
    let mut map = serde_json::Map::new();
    for (field_num, value) in fields {
        let key = field_num.to_string();
        match map.get_mut(&key) {
            Some(existing) => {
                if let Value::Array(arr) = existing {
                    arr.push(value);
                } else {
                    let prev = existing.take();
                    *existing = Value::Array(vec![prev, value]);
                }
            }
            None => {
                map.insert(key, value);
            }
        }
    }

    Some(Value::Object(map))
}

/// デコード結果がネストされたメッセージとして妥当かを判定する。
/// packed varint が偶然有効な protobuf に見える場合、フィールド番号が
/// 異常に大きくなるため、閾値(100)を超えるフィールドがあれば棄却する。
fn is_plausible_message(value: &Value) -> bool {
    const MAX_PLAUSIBLE_FIELD: u32 = 130;
    if let Value::Object(map) = value {
        map.keys().all(|k| {
            k.parse::<u32>().map_or(false, |n| n >= 1 && n <= MAX_PLAUSIBLE_FIELD)
        })
    } else {
        true
    }
}

fn decode_bytes_or_string(chunk: &[u8]) -> Value {
    // UTF-8文字列として解釈可能かチェック
    // 1〜2バイトの短いデータは packed varint の可能性が高いため常に hex にする
    if chunk.len() > 2 {
        if let Ok(s) = std::str::from_utf8(chunk) {
            if s.chars().all(|c| c.is_ascii_graphic() || c.is_ascii_whitespace() || !c.is_control()) {
                return json!(s);
            }
        }
    }
    // バイナリデータは hex 文字列で出力
    let hex: String = chunk.iter().map(|b| format!("{:02x}", b)).collect();
    json!(hex)
}

fn read_varint(data: &[u8], start: usize) -> Option<(u64, usize)> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    let mut pos = start;

    loop {
        if pos >= data.len() {
            return None;
        }
        let byte = data[pos];
        pos += 1;
        result |= ((byte & 0x7F) as u64) << shift;
        if byte & 0x80 == 0 {
            return Some((result, pos));
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
}


fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// hex文字列の packed varint をデコードして Vec<i64> にする
fn decode_packed_varints(hex_str: &str) -> Vec<i64> {
    let bytes = match hex_decode(hex_str) {
        Some(b) => b,
        None => return Vec::new(),
    };
    let mut vals = Vec::new();
    let mut pos = 0;
    while pos < bytes.len() {
        match read_varint(&bytes, pos) {
            Some((val, new_pos)) => {
                vals.push(val as i64);
                pos = new_pos;
            }
            None => break,
        }
    }
    vals
}

/// field 57 (Mod) の mod_infos から uuid → {part_ids, stat_values} のマップを構築する
fn build_mod_info_map(decoded: &Value) -> std::collections::HashMap<i64, Value> {
    let mut map = std::collections::HashMap::new();

    let container = match decoded.get("1") {
        Some(v) => v,
        None => return map,
    };
    let mod_data = match container.get("57") {
        Some(v) => v,
        None => return map,
    };

    // field 2 = mod_infos (repeated map entries: key=uuid, value=ModInfo)
    let infos = match mod_data.get("2") {
        Some(Value::Array(arr)) => arr.clone(),
        Some(v) => vec![v.clone()],
        None => return map,
    };

    for entry in &infos {
        let uuid = match entry.get("1").and_then(|v| v.as_i64()) {
            Some(u) => u,
            None => continue,
        };
        let detail = match entry.get("2") {
            Some(v) => v,
            None => continue,
        };

        // field 1 = part_ids (packed varint, hex文字列)
        let part_ids: Vec<i64> = match detail.get("1") {
            Some(Value::String(s)) => decode_packed_varints(s),
            _ => Vec::new(),
        };

        // field 4 = init_link_nums (packed varint, hex文字列) → ステータス値
        let stat_values: Vec<i64> = match detail.get("4") {
            Some(Value::String(s)) => decode_packed_varints(s),
            _ => Vec::new(),
        };

        // part_ids と stat_values を対にする
        let mut stats = Vec::new();
        for i in 0..part_ids.len().max(stat_values.len()) {
            let pid = part_ids.get(i).copied().unwrap_or(0);
            let val = stat_values.get(i).copied().unwrap_or(0);
            stats.push(json!({"part_id": pid, "value": val}));
        }

        let success_rate = detail.get("3").cloned().unwrap_or(Value::Null);

        map.insert(uuid, json!({
            "stats": stats,
            "success_rate": success_rate,
        }));
    }

    map
}

/// SyncContainerData のデコード済みJSONから Package type=5（モジュール）のアイテム一覧を抽出する。
/// field 57 (Mod) のステータス値も紐付ける。
pub fn extract_modules(decoded: &Value) -> Vec<Value> {
    let mut modules = Vec::new();

    let container = match decoded.get("1") {
        Some(v) => v,
        None => return modules,
    };

    // field 57 からモジュールのステータス情報を取得
    let mod_info_map = build_mod_info_map(decoded);

    // field 57 -> "1" = mod_slots (slot -> uuid)
    let mut slot_map: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    if let Some(mod_data) = container.get("57") {
        let slots = match mod_data.get("1") {
            Some(Value::Array(arr)) => arr.clone(),
            Some(v) => vec![v.clone()],
            None => Vec::new(),
        };
        for slot_entry in &slots {
            if let (Some(slot_id), Some(uuid)) = (
                slot_entry.get("1").and_then(|v| v.as_i64()),
                slot_entry.get("2").and_then(|v| v.as_i64()),
            ) {
                slot_map.insert(uuid, slot_id);
            }
        }
    }

    // field 7 (item_package) -> "1" (packages)
    let item_package = match container.get("7") {
        Some(v) => v,
        None => return modules,
    };
    let packages = match item_package.get("1") {
        Some(Value::Array(arr)) => arr.clone(),
        Some(v) => vec![v.clone()],
        None => return modules,
    };

    for pkg in &packages {
        let pkg_detail = match pkg.get("2") {
            Some(v) => v,
            None => continue,
        };
        if pkg_detail.get("1").and_then(|v| v.as_u64()) != Some(5) {
            continue;
        }

        let items_raw = match pkg_detail.get("4") {
            Some(Value::Array(arr)) => arr.clone(),
            Some(v) => vec![v.clone()],
            None => continue,
        };

        for item_wrapper in &items_raw {
            let item = match item_wrapper.get("2") {
                Some(v) => v,
                None => item_wrapper,
            };

            let uuid = item.get("1").and_then(|v| v.as_i64()).unwrap_or(0);

            let mut module = serde_json::Map::new();
            module.insert("uuid".into(), json!(uuid));
            module.insert("config_id".into(), item.get("2").cloned().unwrap_or(Value::Null));
            module.insert("quality".into(), item.get("9").cloned().unwrap_or(Value::Null));

            // field 57 からステータス情報を紐付け
            if let Some(info) = mod_info_map.get(&uuid) {
                module.insert("stats".into(), info.get("stats").cloned().unwrap_or(Value::Null));
                module.insert("success_rate".into(), info.get("success_rate").cloned().unwrap_or(Value::Null));
            } else {
                module.insert("stats".into(), Value::Null);
                module.insert("success_rate".into(), Value::Null);
            }

            // 装着スロット
            if let Some(slot) = slot_map.get(&uuid) {
                module.insert("equipped_slot".into(), json!(slot));
            }

            modules.push(Value::Object(module));
        }
    }

    modules
}

// ========================================================================
// SyncContainerDirtyData (0x16) パーサー
// ========================================================================

/// Dirty data の変更種別
pub enum DirtyModuleChange {
    /// モジュール追加（コンテナタイプ7, sub-type 5, 詳細データあり）
    Added {
        uuid: i64,
        config_id: u64,
        quality: u64,
    },
    /// モジュール削除（コンテナタイプ7, sub-type 5, uuidのみ）
    Removed { uuid: i64 },
    /// ステータス更新（コンテナタイプ57）
    StatsUpdated {
        uuid: i64,
        stats: Vec<(i64, i64)>,
        success_rate: u64,
    },
}

/// DEADBEEF区切りバイナリの値
#[derive(Debug, Clone)]
enum DVal {
    I32(i32),
    I64(i64),
    Byte(u8),
    Other(()),
}

impl DVal {
    fn as_i32(&self) -> Option<i32> {
        match self {
            DVal::I32(v) => Some(*v),
            _ => None,
        }
    }
    fn as_u64(&self) -> u64 {
        match self {
            DVal::I32(n) => *n as u32 as u64,
            DVal::I64(n) => *n as u64,
            DVal::Byte(b) => *b as u64,
            DVal::Other(_) => 0,
        }
    }
}

const SENTINEL: [u8; 4] = [0xEF, 0xBE, 0xAD, 0xDE];

/// hex文字列をDEADBEEF区切りで値リストにパースする
fn parse_dirty_values(hex_str: &str) -> Vec<DVal> {
    let bytes = match hex_decode(hex_str) {
        Some(b) => b,
        None => return Vec::new(),
    };
    let mut values = Vec::new();
    let mut start = 0;
    loop {
        let pos = bytes[start..]
            .windows(4)
            .position(|w| w == SENTINEL)
            .map(|p| start + p);
        match pos {
            Some(p) => {
                let chunk = &bytes[start..p];
                if !chunk.is_empty() {
                    values.push(match chunk.len() {
                        1 => DVal::Byte(chunk[0]),
                        4 => DVal::I32(i32::from_le_bytes(chunk.try_into().unwrap())),
                        8 => DVal::I64(i64::from_le_bytes(chunk.try_into().unwrap())),
                        _ => DVal::Other(()),
                    });
                }
                start = p + 4;
            }
            None => {
                let chunk = &bytes[start..];
                if !chunk.is_empty() {
                    values.push(match chunk.len() {
                        1 => DVal::Byte(chunk[0]),
                        4 => DVal::I32(i32::from_le_bytes(chunk.try_into().unwrap())),
                        8 => DVal::I64(i64::from_le_bytes(chunk.try_into().unwrap())),
                        _ => DVal::Other(()),
                    });
                }
                break;
            }
        }
    }
    values
}

/// ネストされた -2...-3 ブロックをスキップし、-3 の次のインデックスを返す
fn skip_nested(values: &[DVal], start: usize) -> usize {
    let mut depth = 0;
    let mut i = start;
    while i < values.len() {
        match values[i].as_i32() {
            Some(-2) => depth += 1,
            Some(-3) => {
                depth -= 1;
                if depth == 0 {
                    return i + 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    values.len()
}

/// SyncContainerDirtyData (0x16) のデコード済みJSONからモジュール変更を抽出する
pub fn extract_dirty_changes(decoded: &Value) -> Vec<DirtyModuleChange> {
    let hex_str = match decoded
        .get("1")
        .and_then(|v| v.get("1"))
        .and_then(|v| v.as_str())
    {
        Some(s) => s,
        None => return Vec::new(),
    };

    let values = parse_dirty_values(hex_str);
    if values.len() < 3 {
        return Vec::new();
    }

    // values[0] = -2, values[1] = size, values[2] = container_type
    let container_type = match values.get(2).and_then(|v| v.as_i32()) {
        Some(ct) => ct,
        None => return Vec::new(),
    };

    match container_type {
        7 => extract_from_container7(&values),
        57 => extract_from_container57(&values),
        _ => Vec::new(),
    }
}

/// コンテナタイプ7（アイテムインベントリ）からモジュールの追加/削除を抽出
fn extract_from_container7(values: &[DVal]) -> Vec<DirtyModuleChange> {
    // values[9] = sub-type (5 = modules)
    if values.get(9).and_then(|v| v.as_i32()) != Some(5) {
        return Vec::new();
    }

    // values[10..16] = items block header: -2, size, 4, count, 0, 0
    // values[16] 以降: uuid(i64), detail_block(-2...-3), uuid, detail_block, ... の繰り返し
    let mut results = Vec::new();
    let mut i = 16;

    while i < values.len() {
        match &values[i] {
            DVal::I64(uuid_val) => {
                let uuid = *uuid_val;
                match values.get(i + 1).and_then(|v| v.as_i32()) {
                    Some(-2) => {
                        // 追加: detail block を解析
                        results.extend(extract_module_addition(values, i, uuid));
                        i = skip_nested(values, i + 1);
                    }
                    _ => {
                        // 削除
                        results.push(DirtyModuleChange::Removed { uuid });
                        i += 1;
                    }
                }
            }
            DVal::I32(-2) => {
                i = skip_nested(values, i);
            }
            DVal::I32(-3) => break,
            _ => {
                i += 1;
            }
        }
    }

    results
}

/// コンテナタイプ7の詳細ブロックから config_id, quality を抽出
fn extract_module_addition(values: &[DVal], uuid_idx: usize, uuid: i64) -> Vec<DirtyModuleChange> {
    // uuid_idx+1 = -2 (detail block open), uuid_idx+2 = size
    // uuid_idx+3 以降: field_num, value, field_num, value, ...
    let detail_start = uuid_idx + 3;
    if detail_start >= values.len() {
        return Vec::new();
    }

    let mut config_id: u64 = 0;
    let mut quality: u64 = 0;
    let mut i = detail_start;

    while i < values.len() {
        match values[i].as_i32() {
            Some(-3) => break,
            Some(-2) => {
                i = skip_nested(values, i);
                continue;
            }
            Some(field_num) if field_num >= 1 => {
                i += 1;
                if i >= values.len() {
                    break;
                }
                // 値がネストブロックならスキップ
                if values[i].as_i32() == Some(-2) {
                    i = skip_nested(values, i);
                    continue;
                }
                match field_num {
                    2 => config_id = values[i].as_u64(),
                    9 => quality = values[i].as_u64(),
                    _ => {}
                }
                i += 1;
            }
            _ => {
                i += 1;
            }
        }
    }

    if config_id > 0 {
        vec![DirtyModuleChange::Added {
            uuid,
            config_id,
            quality,
        }]
    } else {
        Vec::new()
    }
}

/// コンテナタイプ57（モジュールステータス）からステータス情報を抽出
fn extract_from_container57(values: &[DVal]) -> Vec<DirtyModuleChange> {
    // values[9] 以降: uuid(i64), stats_block(-2...-3), uuid, stats_block, ... の繰り返し
    let mut results = Vec::new();
    let mut i = 9;

    while i < values.len() {
        let uuid = match &values[i] {
            DVal::I64(v) => *v,
            _ => break,
        };
        i += 1;

        // uuid の次が -3 なら削除通知（container 7 側で処理済み）→ スキップ
        if values.get(i).and_then(|v| v.as_i32()) == Some(-3) {
            i += 1;
            continue;
        }

        // -2 = stats ブロック開始
        if values.get(i).and_then(|v| v.as_i32()) != Some(-2) {
            break;
        }
        let block_end = skip_nested(values, i);
        // ブロック内: i+1=size, i+2 以降がデータ
        let base = i + 2;

        // field 1 = part_ids セクション
        if values.get(base).and_then(|v| v.as_i32()) != Some(1) {
            i = block_end;
            continue;
        }
        let part_count = match values.get(base + 1).and_then(|v| v.as_i32()) {
            Some(c) if c > 0 && c <= 10 => c as usize,
            _ => {
                i = block_end;
                continue;
            }
        };

        let mut part_ids = Vec::new();
        for j in (base + 2)..(base + 2 + part_count) {
            if let Some(v) = values.get(j) {
                part_ids.push(v.as_u64() as i64);
            }
        }

        // ロールエントリをカウントしてステータス値を算出
        let rolls_start = base + 2 + part_count + 2; // field 2 + total_rolls をスキップ
        let mut roll_counts: std::collections::HashMap<i64, i64> =
            std::collections::HashMap::new();
        let mut success_rate: u64 = 0;
        let mut j = rolls_start;

        while j < block_end {
            match values[j].as_i32() {
                Some(-2) => {
                    if let Some(stat_type) = values.get(j + 3).map(|v| v.as_u64() as i64) {
                        if part_ids.contains(&stat_type) {
                            *roll_counts.entry(stat_type).or_insert(0) += 1;
                        }
                    }
                    j = skip_nested(values, j);
                }
                Some(3) => {
                    j += 1;
                    if let Some(v) = values.get(j) {
                        success_rate = v.as_u64();
                    }
                    break;
                }
                Some(-3) => break,
                _ => {
                    j += 1;
                }
            }
        }

        let stats: Vec<(i64, i64)> = part_ids
            .iter()
            .map(|pid| (*pid, *roll_counts.get(pid).unwrap_or(&0)))
            .collect();

        if !stats.is_empty() {
            results.push(DirtyModuleChange::StatsUpdated {
                uuid,
                stats,
                success_rate,
            });
        }

        i = block_end;
    }

    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_varint() {
        // field 1, varint, value 150
        let data = [0x08, 0x96, 0x01];
        let result = decode_protobuf_raw(&data);
        assert_eq!(result, json!({"1": 150}));
    }

    #[test]
    fn test_empty() {
        let result = decode_protobuf_raw(&[]);
        assert_eq!(result, Value::Null);
    }

    #[test]
    fn test_dirty_empty_delta() {
        // 空デルタ (-2, 0, -3) は変更なしを返す
        let hex = "feffffffefbeadde00000000efbeaddefdffffffefbeadde";
        let decoded = json!({"1": {"1": hex}});
        let changes = extract_dirty_changes(&decoded);
        assert!(changes.is_empty());
    }

    #[test]
    fn test_dirty_non_module_container() {
        // コンテナタイプ11（通貨）はスキップされる
        let hex = "feffffffefbeadde10000000efbeadde0b000000efbeaddefdffffffefbeadde";
        let decoded = json!({"1": {"1": hex}});
        let changes = extract_dirty_changes(&decoded);
        assert!(changes.is_empty());
    }
}
