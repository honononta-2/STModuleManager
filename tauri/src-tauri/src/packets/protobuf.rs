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
/// 異常に大きくなるため、閾値(130)を超えるフィールドがあれば棄却する。
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

/// ステータスを part_id の並び順に揃える。並びにない part_id は末尾に元の順で残す。
fn order_stats(stats: &mut [(i64, i64)], order: &[i64]) {
    stats.sort_by_key(|(pid, _)| order.iter().position(|p| p == pid).unwrap_or(usize::MAX));
}

/// アイテムの field 13 から part_id の並びを取得する
fn item_part_id_order(field13: Option<&Value>) -> Vec<i64> {
    match field13 {
        // {"1": packed varint の hex文字列}
        Some(Value::Object(map)) => match map.get("1") {
            Some(Value::String(s)) => decode_packed_varints(s),
            _ => Vec::new(),
        },
        // 4バイト以下でネスト展開されなかったメッセージ全体の hex文字列
        Some(Value::String(s)) => hex_decode(s)
            .map(|bytes| decode_protobuf_raw(&bytes))
            .and_then(|v| v.get("1").and_then(|x| x.as_str()).map(decode_packed_varints))
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// アイテムの field 21 から (part_id, value) の一覧を取得する
fn item_stats(field21: Option<&Value>) -> Option<Vec<(i64, i64)>> {
    let entries = match field21?.get("1")? {
        Value::Array(arr) => arr.clone(),
        v => vec![v.clone()],
    };
    Some(
        entries
            .iter()
            .filter_map(|e| {
                let pid = e.get("1").and_then(|v| v.as_i64())?;
                let val = e.get("2").and_then(|v| v.as_i64()).unwrap_or(0);
                Some((pid, val))
            })
            .collect(),
    )
}

/// SyncContainerData のデコード済みJSONから Package type=5（モジュール）のアイテム一覧を抽出する。
/// field 57 (Mod) の装着スロットも紐付ける。
pub fn extract_modules(decoded: &Value) -> Vec<Value> {
    let mut modules = Vec::new();

    let container = match decoded.get("1") {
        Some(v) => v,
        None => return modules,
    };

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

            // field 21 = ステータス、field 13 = part_id の並び
            match item_stats(item.get("21")) {
                Some(mut stats) => {
                    order_stats(&mut stats, &item_part_id_order(item.get("13")));
                    let stats: Vec<Value> = stats
                        .iter()
                        .map(|(pid, val)| json!({"part_id": pid, "value": val}))
                        .collect();
                    module.insert("stats".into(), json!(stats));
                }
                None => {
                    module.insert("stats".into(), Value::Null);
                }
            }
            module.insert("success_rate".into(), Value::Null);

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
        stats: Vec<(i64, i64)>,
    },
    /// モジュール削除（コンテナタイプ7, sub-type 5, uuidのみ）
    Removed { uuid: i64 },
}

/// ブロック開始マーカー
const BLOCK_OPEN: i32 = -2;
/// ブロック終了マーカー
const BLOCK_CLOSE: i32 = -3;

fn read_i32(bytes: &[u8], pos: usize) -> Option<i32> {
    let chunk = bytes.get(pos..pos.checked_add(4)?)?;
    Some(i32::from_le_bytes(chunk.try_into().ok()?))
}

fn read_i64(bytes: &[u8], pos: usize) -> Option<i64> {
    let chunk = bytes.get(pos..pos.checked_add(8)?)?;
    Some(i64::from_le_bytes(chunk.try_into().ok()?))
}

/// pos から始まるブロック（-2, 長さ, 中身, -3）の中身の範囲 (開始, 終了) を返す。
/// 終了位置には -3 がある。
fn block_range(bytes: &[u8], pos: usize) -> Option<(usize, usize)> {
    if read_i32(bytes, pos)? != BLOCK_OPEN {
        return None;
    }
    let len = usize::try_from(read_i32(bytes, pos + 4)?).ok()?;
    let start = pos + 8;
    let end = start.checked_add(len)?;
    if read_i32(bytes, end)? != BLOCK_CLOSE {
        return None;
    }
    Some((start, end))
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

    let bytes = match hex_decode(hex_str) {
        Some(b) => b,
        None => return Vec::new(),
    };

    // 全体ブロックの中身: container_type, パッケージブロック, ...
    let (start, _) = match block_range(&bytes, 0) {
        Some(r) => r,
        None => return Vec::new(),
    };

    match read_i32(&bytes, start) {
        Some(7) => extract_from_container7(&bytes, start + 4),
        _ => Vec::new(),
    }
}

/// コンテナタイプ7（アイテムインベントリ）からモジュールの追加/削除を抽出
fn extract_from_container7(bytes: &[u8], pos: usize) -> Vec<DirtyModuleChange> {
    let mut results = Vec::new();

    // パッケージブロックの中身の16バイト目 = sub-type (5 = modules)
    let (pkg_start, _) = match block_range(bytes, pos) {
        Some(r) => r,
        None => return results,
    };
    if read_i32(bytes, pkg_start + 16) != Some(5) {
        return results;
    }

    // items ブロックの中身: 4, 追加件数, 削除件数, 0 の後に
    // uuid(i64), detail_block(-2...-3) または uuid(i64) のみ、の繰り返し
    let (items_start, items_end) = match block_range(bytes, pkg_start + 20) {
        Some(r) => r,
        None => return results,
    };
    let mut p = items_start + 16;

    while p + 8 <= items_end {
        let uuid = match read_i64(bytes, p) {
            Some(u) => u,
            None => break,
        };
        p += 8;

        if p < items_end && read_i32(bytes, p) == Some(BLOCK_OPEN) {
            // 追加: detail block を解析
            let (detail_start, detail_end) = match block_range(bytes, p) {
                Some(r) => r,
                None => break,
            };
            match extract_module_addition(bytes, detail_start, detail_end, uuid) {
                Some(change) => results.push(change),
                None => eprintln!("[monitor] モジュール追加の解析失敗: uuid={}", uuid),
            }
            p = detail_end + 4;
        } else {
            // 削除
            results.push(DirtyModuleChange::Removed { uuid });
        }
    }

    results
}

/// 詳細ブロック内のフィールドのうち、ブロック以外の値のバイト幅
fn scalar_width(field_num: i32) -> Option<usize> {
    match field_num {
        1 | 3 | 6 | 7 | 12 | 15 | 17 | 20 => Some(8),
        2 | 4 | 5 | 8 | 9 | 16 | 18 => Some(4),
        19 | 22 => Some(1),
        _ => None,
    }
}

/// コンテナタイプ7の詳細ブロックから config_id, quality, ステータスを抽出
fn extract_module_addition(
    bytes: &[u8],
    start: usize,
    end: usize,
    uuid: i64,
) -> Option<DirtyModuleChange> {
    // 中身: field_num(4バイト), 値, field_num, 値, ...
    let mut config_id: u64 = 0;
    let mut quality: u64 = 0;
    let mut part_ids: Vec<i64> = Vec::new();
    let mut stats: Vec<(i64, i64)> = Vec::new();
    let mut p = start;

    while p < end {
        let field_num = read_i32(bytes, p)?;
        p += 4;

        // 値がブロックの場合
        if read_i32(bytes, p) == Some(BLOCK_OPEN) {
            let (block_start, block_end) = block_range(bytes, p)?;
            match field_num {
                13 => part_ids = read_part_ids(bytes, block_start, block_end),
                21 => stats = read_stats(bytes, block_start, block_end),
                _ => {}
            }
            p = block_end + 4;
            continue;
        }

        let width = scalar_width(field_num)?;
        if p + width > end {
            return None;
        }
        match field_num {
            2 => config_id = read_i32(bytes, p)? as u32 as u64,
            9 => quality = read_i32(bytes, p)? as u32 as u64,
            _ => {}
        }
        p += width;
    }

    if config_id == 0 {
        return None;
    }
    order_stats(&mut stats, &part_ids);

    Some(DirtyModuleChange::Added {
        uuid,
        config_id,
        quality,
        stats,
    })
}

/// field 13 ブロック（1, 件数, part_id...）から part_id の並びを読む
fn read_part_ids(bytes: &[u8], start: usize, end: usize) -> Vec<i64> {
    if read_i32(bytes, start) != Some(1) {
        return Vec::new();
    }
    let count = match read_i32(bytes, start + 4) {
        Some(c) if c > 0 => c as usize,
        _ => return Vec::new(),
    };
    let max = end.saturating_sub(start + 8) / 4;
    (0..count.min(max))
        .filter_map(|i| read_i32(bytes, start + 8 + i * 4).map(|v| v as i64))
        .collect()
}

/// field 21 ブロック（1, -1, 件数, (part_id, value)...）からステータスを読む
fn read_stats(bytes: &[u8], start: usize, end: usize) -> Vec<(i64, i64)> {
    if read_i32(bytes, start) != Some(1) || read_i32(bytes, start + 4) != Some(-1) {
        return Vec::new();
    }
    let count = match read_i32(bytes, start + 8) {
        Some(c) if c > 0 => c as usize,
        _ => return Vec::new(),
    };
    let max = end.saturating_sub(start + 12) / 8;
    (0..count.min(max))
        .filter_map(|i| {
            let q = start + 12 + i * 8;
            Some((read_i32(bytes, q)? as i64, read_i32(bytes, q + 4)? as i64))
        })
        .collect()
}
