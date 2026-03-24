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
}
