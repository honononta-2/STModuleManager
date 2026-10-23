use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_BUFFER_OVERFLOW, ERROR_INSUFFICIENT_BUFFER, INVALID_HANDLE_VALUE, NO_ERROR,
};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetAdaptersAddresses, GetExtendedTcpTable, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
    GAA_FLAG_SKIP_MULTICAST, IF_TYPE_SOFTWARE_LOOPBACK, IP_ADAPTER_ADDRESSES_LH,
    MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, MIB_TCP_STATE_ESTAB, TCP_TABLE_OWNER_PID_ALL,
};
use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
use windows_sys::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};

const GAME_PROCESS_NAMES: [&str; 2] = ["StarASIA.exe", "BPSR.exe"];
/// GetAdaptersAddresses の資料が推奨する初期バッファサイズ
const ADAPTER_BUFFER_BYTES: usize = 15 * 1024;

pub struct GameConnection {
    pub local: ([u8; 4], u16),
    pub remote: ([u8; 4], u16),
}

pub struct Adapter {
    pub label: String,
    pub up: bool,
    pub ipv4: Vec<[u8; 4]>,
}

fn find_game_pids() -> Vec<u32> {
    let mut found = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return found;
        }
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut ok = Process32FirstW(snapshot, &mut entry) != 0;
        while ok {
            let len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
            if GAME_PROCESS_NAMES
                .iter()
                .any(|game| game.eq_ignore_ascii_case(&name))
            {
                found.push(entry.th32ProcessID);
            }
            ok = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
    }
    found
}

pub fn game_connections() -> Vec<GameConnection> {
    let pids = find_game_pids();
    if pids.is_empty() {
        return Vec::new();
    }

    let mut buffer: Vec<u32> = Vec::new();
    loop {
        let mut size = (buffer.len() * 4) as u32;
        let table = if buffer.is_empty() {
            std::ptr::null_mut()
        } else {
            buffer.as_mut_ptr().cast()
        };
        let result = unsafe {
            GetExtendedTcpTable(
                table,
                &mut size,
                0,
                AF_INET as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            )
        };
        match result {
            NO_ERROR => break,
            ERROR_INSUFFICIENT_BUFFER => buffer.resize((size as usize).div_ceil(4), 0),
            _ => return Vec::new(),
        }
    }

    let rows: &[MIB_TCPROW_OWNER_PID] = unsafe {
        let table = buffer.as_ptr().cast::<MIB_TCPTABLE_OWNER_PID>();
        std::slice::from_raw_parts(
            std::ptr::addr_of!((*table).table).cast::<MIB_TCPROW_OWNER_PID>(),
            (*table).dwNumEntries as usize,
        )
    };

    rows.iter()
        .filter(|row| row.dwState == MIB_TCP_STATE_ESTAB as u32)
        .filter(|row| pids.contains(&row.dwOwningPid))
        .filter(|row| row.dwRemoteAddr.to_ne_bytes()[0] != 127)
        .map(|row| GameConnection {
            local: (row.dwLocalAddr.to_ne_bytes(), to_port(row.dwLocalPort)),
            remote: (row.dwRemoteAddr.to_ne_bytes(), to_port(row.dwRemotePort)),
        })
        .collect()
}

pub fn adapters() -> Vec<Adapter> {
    let mut adapters = Vec::new();
    let mut buffer: Vec<u64> = vec![0; ADAPTER_BUFFER_BYTES / 8];
    loop {
        let mut size = (buffer.len() * 8) as u32;
        let result = unsafe {
            GetAdaptersAddresses(
                AF_INET as u32,
                GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER,
                std::ptr::null(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        match result {
            NO_ERROR => break,
            ERROR_BUFFER_OVERFLOW => buffer.resize((size as usize).div_ceil(8), 0),
            _ => return adapters,
        }
    }

    unsafe {
        let mut adapter = buffer.as_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        while !adapter.is_null() {
            if (*adapter).IfType != IF_TYPE_SOFTWARE_LOOPBACK {
                let mut ipv4 = Vec::new();
                let mut unicast = (*adapter).FirstUnicastAddress;
                while !unicast.is_null() {
                    let sockaddr = (*unicast).Address.lpSockaddr;
                    if !sockaddr.is_null() && (*sockaddr).sa_family == AF_INET {
                        let addr = (*sockaddr.cast::<SOCKADDR_IN>()).sin_addr.S_un.S_addr;
                        ipv4.push(addr.to_ne_bytes());
                    }
                    unicast = (*unicast).Next;
                }
                adapters.push(Adapter {
                    label: format!(
                        "{} ({})",
                        from_wide((*adapter).FriendlyName),
                        from_wide((*adapter).Description)
                    ),
                    up: (*adapter).OperStatus == IfOperStatusUp,
                    ipv4,
                });
            }
            adapter = (*adapter).Next;
        }
    }
    adapters
}

pub fn adapter_label(adapters: &[Adapter], addr: [u8; 4]) -> &str {
    adapters
        .iter()
        .find(|a| a.ipv4.contains(&addr))
        .map_or("不明", |a| a.label.as_str())
}

pub(crate) unsafe fn from_wide(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let len = (0..).take_while(|&i| *ptr.add(i) != 0).count();
    String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
}

/// ポート番号は下位16ビットにネットワークバイト順で入っている
fn to_port(raw: u32) -> u16 {
    u16::from_be(raw as u16)
}
