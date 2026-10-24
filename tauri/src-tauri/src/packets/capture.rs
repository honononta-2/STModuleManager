use super::netstat;
use super::opcodes::FragmentType;
use super::reassembler::Reassembler;
use super::utils::{BinaryReader, Server, TCPReassembler, tcp_sequence_before};
use etherparse::NetSlice::Ipv4;
use etherparse::SlicedPacket;
use etherparse::TransportSlice::Tcp;
use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windivert::WinDivert;
use windivert::error::{WinDivertError, WinDivertOpenError};
use windivert::prelude::WinDivertFlags;

const MAX_BACKTRACK_BYTES: u32 = 2 * 1024 * 1024;
/// zstd展開の最大出力サイズ（展開爆弾対策）
const MAX_DECOMPRESS_BYTES: usize = 16 * 1024 * 1024; // 16 MB
/// フレーム再帰展開の最大深さ
const MAX_FRAME_DEPTH: usize = 10;
/// 判定処理が読むフレーム先頭の22バイトが収まる長さ
const REJECTED_HEAD_BYTES: usize = 32;

#[derive(Default)]
struct SourceStat {
    received: u64,
    rejected_head: Option<Vec<u8>>,
}

type SourceStats = Arc<Mutex<HashMap<([u8; 4], u16), SourceStat>>>;

/// サイズ制限付きzstd展開。出力が MAX_DECOMPRESS_BYTES を超えた場合はエラーを返す。
fn zstd_decode_limited(data: &[u8]) -> Result<Vec<u8>, std::io::Error> {
    use std::io::Read;
    let mut decoder = zstd::stream::Decoder::new(data)?;
    let mut output = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = decoder.read(&mut buf)?;
        if n == 0 {
            break;
        }
        output.extend_from_slice(&buf[..n]);
        if output.len() > MAX_DECOMPRESS_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "decompressed data exceeds size limit",
            ));
        }
    }
    Ok(output)
}

/// キャプチャした1パケットの情報（モジュール関連のみ送信）
pub struct ModulePayload {
    pub opcode: u32,
    pub payload: Vec<u8>,
}

/// バックグラウンド監視ループ。stop が true になるまでパケットを監視する。
/// server_found: サーバー検出時に true にセットされる
/// module_tx: SyncContainerData (0x15) のペイロードを送信するチャネル
pub fn run_capture(
    stop: Arc<AtomicBool>,
    server_found: Arc<AtomicBool>,
    module_tx: Sender<ModulePayload>,
) {
    if !super::driver::is_ready() {
        crate::diag!("[capture] WinDivert.dll が読み込まれていないため監視を開始しません");
        return;
    }

    let diagnostic = crate::logger::is_enabled();
    if diagnostic {
        crate::diag!(
            "[capture] WinDivert サービス(開始前): {}",
            crate::env_info::windivert_service()
        );
    }
    super::driver::remove_stale_service();

    let handle = match WinDivert::network(
        "!loopback && ip && tcp",
        0,
        WinDivertFlags::new().set_sniff(),
    ) {
        Ok(h) => h,
        Err(e) => {
            crate::diag!("[capture] WinDivert の開始に失敗: {}", describe_open_error(&e));
            return;
        }
    };

    if diagnostic {
        crate::diag!(
            "[capture] WinDivert 開始成功 サービス: {}",
            crate::env_info::windivert_service()
        );
    }

    let started_at = Instant::now();
    let finished = Arc::new(AtomicBool::new(false));
    let received = Arc::new(AtomicU64::new(0));
    let received_from_server = Arc::new(AtomicU64::new(0));
    let source_stats: SourceStats = Arc::new(Mutex::new(HashMap::new()));
    if diagnostic {
        spawn_heartbeat(
            stop.clone(),
            finished.clone(),
            server_found.clone(),
            received.clone(),
            received_from_server.clone(),
            source_stats.clone(),
        );
    }

    let mut buffer = vec![0u8; 10 * 1024 * 1024];
    let mut known_server: Option<Server> = None;
    let mut tcp_reassembler = TCPReassembler::new();
    let mut reassembler = Reassembler::new();

    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }

        let packet_data = match handle.recv(Some(&mut buffer)) {
            Ok(pkt) => pkt.data.to_vec(),
            Err(e) => {
                crate::diag!("[capture] recv エラー: {}", e);
                break;
            }
        };
        received.fetch_add(1, Ordering::Relaxed);

        if stop.load(Ordering::Relaxed) {
            break;
        }

        let Ok(sliced) = SlicedPacket::from_ip(&packet_data) else {
            continue;
        };
        let Some(Ipv4(ip)) = sliced.net else { continue };
        let Some(Tcp(tcp)) = sliced.transport else { continue };

        let curr_server = Server::new(
            ip.header().source(),
            tcp.to_header().source_port,
            ip.header().destination(),
            tcp.to_header().destination_port,
        );

        // ゲームサーバーをまだ特定していない場合、パケット内容から検出を試みる
        if known_server != Some(curr_server) {
            let tcp_payload = tcp.payload();
            let detected = try_detect_game_server(tcp_payload, 0);

            if diagnostic && known_server.is_none() {
                record_source(
                    &source_stats,
                    (ip.header().source(), tcp.source_port()),
                    tcp_payload,
                    detected.is_some(),
                );
            }

            if let Some(method) = detected {
                let adapters = netstat::adapters();
                crate::diag!(
                    "[capture] ゲームサーバー検出: {} 経由: {} 判定: {} 監視開始から{}秒",
                    curr_server,
                    netstat::adapter_label(&adapters, ip.header().destination()),
                    method.label(),
                    started_at.elapsed().as_secs()
                );
                known_server = Some(curr_server);
                server_found.store(true, Ordering::Relaxed);
                let seq_end = tcp
                    .sequence_number()
                    .wrapping_add(tcp_payload.len() as u32);
                tcp_reassembler.reset(Some(seq_end));
                reassembler = Reassembler::new();
            }

            continue;
        }

        // ----- 以下、特定済みサーバーからのパケットのみ処理 -----

        received_from_server.fetch_add(1, Ordering::Relaxed);
        let sequence_number = tcp.sequence_number();
        let payload = tcp.payload();

        if tcp.syn() {
            tcp_reassembler.reset(Some(sequence_number.wrapping_add(1)));
            reassembler = Reassembler::new();
            if payload.is_empty() {
                continue;
            }
        }

        let defer_reset = tcp.fin() || tcp.rst();

        if payload.is_empty() {
            if defer_reset {
                tcp_reassembler.reset(None);
                reassembler = Reassembler::new();
            }
            continue;
        }

        // TCPシーケンス番号の逆行チェック
        if let Some(expected) = tcp_reassembler.next_sequence() {
            if tcp_sequence_before(sequence_number, expected) {
                let backwards = expected.wrapping_sub(sequence_number);
                if backwards > MAX_BACKTRACK_BYTES {
                    crate::diag!(
                        "[capture] シーケンス番号が{}バイト戻ったため組み立て直しをリセット",
                        backwards
                    );
                    tcp_reassembler.reset(Some(sequence_number));
                    reassembler = Reassembler::new();
                }
            }
        }

        if let Some(data) = tcp_reassembler.insert_segment(sequence_number, payload) {
            reassembler.feed_owned(data);
        }

        while let Some(frame) = reassembler.try_next() {
            process_frame(BinaryReader::from(frame), &module_tx, 0);
        }

        if defer_reset {
            tcp_reassembler.reset(None);
            reassembler = Reassembler::new();
        }
    }

    finished.store(true, Ordering::Relaxed);
    crate::diag!("[capture] キャプチャ終了。");
}

/// パケットが来ない間は recv が戻らないため、受信ループとは別スレッドで書く
fn spawn_heartbeat(
    stop: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
    server_found: Arc<AtomicBool>,
    received: Arc<AtomicU64>,
    received_from_server: Arc<AtomicU64>,
    source_stats: SourceStats,
) {
    std::thread::spawn(move || {
        if !server_found.load(Ordering::Relaxed) {
            log_game_connections(None);
        }
        let mut last = Instant::now();
        loop {
            std::thread::sleep(Duration::from_secs(1));
            if stop.load(Ordering::Relaxed) || finished.load(Ordering::Relaxed) {
                break;
            }
            if last.elapsed() < Duration::from_secs(60) {
                continue;
            }
            last = Instant::now();
            let found = server_found.load(Ordering::Relaxed);
            let state = if found {
                "サーバー接続済み"
            } else {
                "サーバー検出中"
            };
            crate::diag!(
                "[capture] 直近1分の受信: {}件 うちゲームサーバーから{}件 状態: {}",
                received.swap(0, Ordering::Relaxed),
                received_from_server.swap(0, Ordering::Relaxed),
                state
            );
            let stats = source_stats
                .lock()
                .map(|mut s| std::mem::take(&mut *s))
                .unwrap_or_default();
            if !found {
                log_game_connections(Some(&stats));
            }
        }
    });
}

fn record_source(stats: &SourceStats, source: ([u8; 4], u16), payload: &[u8], detected: bool) {
    let Ok(mut map) = stats.lock() else { return };
    let stat = map.entry(source).or_default();
    stat.received += 1;
    if !detected && !payload.is_empty() && stat.rejected_head.is_none() {
        stat.rejected_head = Some(payload[..payload.len().min(REJECTED_HEAD_BYTES)].to_vec());
    }
}

fn log_game_connections(stats: Option<&HashMap<([u8; 4], u16), SourceStat>>) {
    let connections = netstat::game_connections();
    if connections.is_empty() {
        return;
    }
    let adapters = netstat::adapters();
    for conn in &connections {
        let mut line = format!(
            "[diag] ゲームの接続: {} -> {} 経由: {}",
            format_endpoint(conn.local),
            format_endpoint(conn.remote),
            netstat::adapter_label(&adapters, conn.local.0)
        );
        if let Some(stats) = stats {
            let stat = stats.get(&conn.remote);
            line.push_str(&format!(" 受信: {}件", stat.map_or(0, |s| s.received)));
            if let Some(head) = stat.and_then(|s| s.rejected_head.as_deref()) {
                line.push_str(&format!(" 判定外パケット先頭: {}", to_hex(head)));
            }
        }
        crate::diag!("{}", line);
    }
}

fn format_endpoint((addr, port): ([u8; 4], u16)) -> String {
    format!("{}:{}", Ipv4Addr::from(addr), port)
}

fn to_hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<Vec<_>>()
        .join(" ")
}

fn describe_open_error(e: &WinDivertError) -> String {
    // windivert クレートは 1275 を 1257 と誤って対応付けているため、1275 は IOError 側で届く
    let code = match e {
        WinDivertError::Open(open) => Some(match open {
            WinDivertOpenError::MissingSYS => 2,
            WinDivertOpenError::AccessDenied => 5,
            WinDivertOpenError::InvalidParameter => 87,
            WinDivertOpenError::InvalidImageHash => 577,
            WinDivertOpenError::IncompatibleVersion => 654,
            WinDivertOpenError::MissingInstall => 1060,
            WinDivertOpenError::DriverBlocked => 1257,
            WinDivertOpenError::BaseFilteringEngineDisabled => 1753,
        }),
        WinDivertError::IOError(io) => io.raw_os_error(),
        _ => None,
    };
    let Some(code) = code else {
        return e.to_string();
    };
    let meaning = match code {
        2 => "WinDivert64.sys が見つかりません".to_string(),
        5 => "管理者権限がありません".to_string(),
        577 => "ドライバの署名が無効です".to_string(),
        654 => "互換性のない別バージョンの WinDivert ドライバが読み込まれています".to_string(),
        1058 => "WinDivert のサービスが無効になっています".to_string(),
        1275 => "セキュリティソフトなどにドライバがブロックされました".to_string(),
        _ => std::io::Error::from_raw_os_error(code).to_string(),
    };
    format!("コード {} {}", code, meaning)
}

/// 1フレームを解析し、SyncContainerData (0x15) を検出したらチャネルに送信
fn process_frame(mut reader: BinaryReader, module_tx: &Sender<ModulePayload>, depth: usize) {
    if depth > MAX_FRAME_DEPTH {
        return;
    }
    while reader.remaining() > 0 {
        let frame_size = match reader.peek_u32() {
            Ok(sz) => sz,
            Err(_) => break,
        };
        if frame_size < 6 {
            break;
        }
        let frame_bytes = match reader.read_bytes(frame_size as usize) {
            Ok(b) => b,
            Err(_) => break,
        };
        let mut inner = BinaryReader::from(frame_bytes);
        if inner.read_u32().is_err() {
            break;
        }

        let packet_type = match inner.read_u16() {
            Ok(pt) => pt,
            Err(_) => break,
        };
        let is_zstd = (packet_type & 0x8000) != 0;
        let frag_type = FragmentType::from(packet_type & 0x7fff);

        match frag_type {
            FragmentType::Notify | FragmentType::Return | FragmentType::Call => {
                if let Some((opcode, payload)) = parse_service_frame(&mut inner, is_zstd) {
                    // SyncContainerData (0x15) と SyncContainerDirtyData (0x16) をチャネルに送信
                    if opcode == 0x15 || opcode == 0x16 {
                        let _ = module_tx.send(ModulePayload { opcode, payload });
                    }
                }
            }
            FragmentType::FrameDown => {
                let _ = inner.read_u32(); // server_sequence_id をスキップ
                if inner.remaining() == 0 {
                    break;
                }
                let nested = inner.read_remaining().to_vec();
                let nested_data = if is_zstd {
                    match zstd_decode_limited(nested.as_slice()) {
                        Ok(d) => d,
                        Err(_) => continue,
                    }
                } else {
                    nested
                };
                // FrameDown の中身を再帰的に処理
                process_frame(BinaryReader::from(nested_data), module_tx, depth + 1);
            }
            _ => continue,
        }
    }
}

/// Notify/Call/Return フラグメントを解析して (method_id, payload) を返す。
fn parse_service_frame(reader: &mut BinaryReader, compressed: bool) -> Option<(u32, Vec<u8>)> {
    let service_uuid = reader.read_u64().ok()?;
    let _ = reader.read_u32().ok()?; // stub_id
    let method_id = reader.read_u32().ok()?;

    // ゲームのサービスUUIDチェック
    if service_uuid != GAME_SERVICE_UUID {
        return None;
    }

    let payload = reader.read_remaining().to_vec();
    if compressed {
        zstd_decode_limited(payload.as_slice()).ok().map(|d| (method_id, d))
    } else {
        Some((method_id, payload))
    }
}

const GAME_SERVICE_UUID: u64 = 0x0000000063335342;

#[derive(Clone, Copy)]
enum DetectMethod {
    Notify,
    FrameDown,
    LoginPacket,
}

impl DetectMethod {
    fn label(self) -> &'static str {
        match self {
            DetectMethod::Notify => "Notify の UUID",
            DetectMethod::FrameDown => "FrameDown の中身",
            DetectMethod::LoginPacket => "ログイン時のパケット",
        }
    }
}

/// TCPペイロードをゲームプロトコルとして試しにパースし、
/// service_uuid が一致するフレームが見つかればゲームサーバーと判定する。
fn try_detect_game_server(tcp_payload: &[u8], depth: usize) -> Option<DetectMethod> {
    if depth > MAX_FRAME_DEPTH {
        return None;
    }
    // 最低限フレームヘッダ (4 len + 2 type + 8 uuid + 4 stub + 4 method = 22) が必要
    if tcp_payload.len() < 22 {
        return None;
    }

    let mut scan = BinaryReader::from(tcp_payload.to_vec());
    let mut iterations = 0;

    while scan.remaining() >= 6 {
        iterations += 1;
        if iterations > 100 {
            break; // 安全弁
        }

        let frame_len = match scan.peek_u32() {
            Ok(l) => l as usize,
            Err(_) => break,
        };

        // フレーム長の妥当性チェック
        if frame_len < 6 || frame_len > 10 * 1024 * 1024 {
            break;
        }
        if scan.remaining() < frame_len {
            break;
        }

        let frame_bytes = match scan.read_bytes(frame_len) {
            Ok(b) => b,
            Err(_) => break,
        };

        let mut inner = BinaryReader::from(frame_bytes);
        if inner.read_u32().is_err() {
            break;
        }

        let packet_type = match inner.read_u16() {
            Ok(pt) => pt,
            Err(_) => break,
        };

        let frag_type = FragmentType::from(packet_type & 0x7fff);

        match frag_type {
            FragmentType::Notify => {
                // service_uuid を読んでチェック
                if let Ok(uuid) = inner.read_u64() {
                    if uuid == GAME_SERVICE_UUID {
                        return Some(DetectMethod::Notify);
                    }
                }
            }
            FragmentType::FrameDown => {
                // FrameDown 内のネストされたフレームも確認
                let _ = inner.read_u32(); // server_sequence_id skip
                if inner.remaining() > 0 {
                    let nested = inner.read_remaining();
                    let is_zstd = (packet_type & 0x8000) != 0;
                    let nested_data = if is_zstd {
                        match zstd_decode_limited(nested) {
                            Ok(d) => d,
                            Err(_) => continue,
                        }
                    } else {
                        nested.to_vec()
                    };
                    if try_detect_game_server(&nested_data, depth + 1).is_some() {
                        return Some(DetectMethod::FrameDown);
                    }
                }
            }
            _ => {}
        }
    }

    // フォールバック: ログインパケット検出（長さ98）
    if tcp_payload.len() == 98 {
        const SIG1: [u8; 10] = [0x00, 0x00, 0x00, 0x62, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01];
        const SIG2: [u8; 6] = [0x00, 0x00, 0x00, 0x00, 0x0a, 0x4e];
        if tcp_payload[0..10] == SIG1 && tcp_payload[14..20] == SIG2 {
            return Some(DetectMethod::LoginPacket);
        }
    }

    None
}
