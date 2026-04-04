use super::opcodes::FragmentType;
use super::reassembler::Reassembler;
use super::utils::{BinaryReader, Server, TCPReassembler, tcp_sequence_before};
use etherparse::NetSlice::Ipv4;
use etherparse::SlicedPacket;
use etherparse::TransportSlice::Tcp;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use windivert::WinDivert;
use windivert::prelude::WinDivertFlags;

const MAX_BACKTRACK_BYTES: u32 = 2 * 1024 * 1024;
/// zstd展開の最大出力サイズ（展開爆弾対策）
const MAX_DECOMPRESS_BYTES: usize = 16 * 1024 * 1024; // 16 MB

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
    let handle = match WinDivert::network(
        "!loopback && ip && tcp",
        0,
        WinDivertFlags::new().set_sniff(),
    ) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("[エラー] WinDivert初期化失敗: {}", e);
            eprintln!("  → 管理者権限で実行してください。");
            return;
        }
    };

    eprintln!("[capture] WinDivert オープン完了。パケット待機中...");

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
                eprintln!("[capture] recv エラー: {}", e);
                break;
            }
        };

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

            if try_detect_game_server(tcp_payload) {
                eprintln!("[capture] ゲームサーバー検出: {}", curr_server);
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
                    tcp_reassembler.reset(Some(sequence_number));
                    reassembler = Reassembler::new();
                }
            }
        }

        if let Some(data) = tcp_reassembler.insert_segment(sequence_number, payload) {
            reassembler.feed_owned(data);
        }

        while let Some(frame) = reassembler.try_next() {
            process_frame(BinaryReader::from(frame), &module_tx);
        }

        if defer_reset {
            tcp_reassembler.reset(None);
            reassembler = Reassembler::new();
        }
    }

    eprintln!("[capture] キャプチャ終了。");
}

/// 1フレームを解析し、SyncContainerData (0x15) を検出したらチャネルに送信
fn process_frame(mut reader: BinaryReader, module_tx: &Sender<ModulePayload>) {
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
                process_frame(BinaryReader::from(nested_data), module_tx);
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

/// TCPペイロードをゲームプロトコルとして試しにパースし、
/// service_uuid が一致するフレームが見つかればゲームサーバーと判定する。
fn try_detect_game_server(tcp_payload: &[u8]) -> bool {
    // 最低限フレームヘッダ (4 len + 2 type + 8 uuid + 4 stub + 4 method = 22) が必要
    if tcp_payload.len() < 22 {
        return false;
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
                        return true;
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
                    if try_detect_game_server(&nested_data) {
                        return true;
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
            return true;
        }
    }

    false
}
