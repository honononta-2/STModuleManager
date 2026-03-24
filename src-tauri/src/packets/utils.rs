use byteorder::{BigEndian, ReadBytesExt};
use std::collections::BTreeMap;
use std::fmt;
use std::io::{self, Cursor, Read};

#[derive(Copy, Clone, PartialEq, Eq)]
pub struct Server {
    src_addr: [u8; 4],
    src_port: u16,
    dst_addr: [u8; 4],
    dst_port: u16,
}

impl Server {
    pub fn new(src_addr: [u8; 4], src_port: u16, dst_addr: [u8; 4], dst_port: u16) -> Self {
        Self { src_addr, src_port, dst_addr, dst_port }
    }
}

impl fmt::Display for Server {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}.{}.{}.{}:{} -> {}.{}.{}.{}:{}",
            self.src_addr[0], self.src_addr[1], self.src_addr[2], self.src_addr[3],
            self.src_port,
            self.dst_addr[0], self.dst_addr[1], self.dst_addr[2], self.dst_addr[3],
            self.dst_port,
        )
    }
}

#[inline]
pub fn tcp_sequence_before(a: u32, b: u32) -> bool {
    (a.wrapping_sub(b) as i32) < 0
}

pub struct TCPReassembler {
    cache: BTreeMap<u32, Vec<u8>>,
    next_seq: Option<u32>,
    buffered_bytes: usize,
}

const MAX_TCP_CACHE_SIZE: usize = 5 * 1024 * 1024;

impl TCPReassembler {
    pub fn new() -> Self {
        Self { cache: BTreeMap::new(), next_seq: None, buffered_bytes: 0 }
    }

    pub fn insert_segment(&mut self, sequence_number: u32, payload: &[u8]) -> Option<Vec<u8>> {
        if payload.is_empty() {
            return None;
        }

        let expected = match self.next_seq {
            Some(seq) => seq,
            None => {
                self.next_seq = Some(sequence_number);
                sequence_number
            }
        };

        let mut start_seq = sequence_number;
        let mut data = payload;

        if tcp_sequence_before(start_seq, expected) {
            let overlap = expected.wrapping_sub(start_seq) as usize;
            if overlap >= data.len() {
                return None;
            }
            start_seq = expected;
            data = &data[overlap..];
        }

        match self.cache.get_mut(&start_seq) {
            Some(existing) => {
                if data.len() > existing.len() {
                    self.buffered_bytes -= existing.len();
                    existing.clear();
                    existing.extend_from_slice(data);
                    self.buffered_bytes += existing.len();
                }
            }
            None => {
                self.cache.insert(start_seq, data.to_vec());
                self.buffered_bytes += data.len();
            }
        }

        if self.buffered_bytes > MAX_TCP_CACHE_SIZE {
            eprintln!(
                "[tcp] バッファ超過 ({} bytes)。ドロップしてリセット。",
                self.buffered_bytes
            );
            self.cache.clear();
            self.buffered_bytes = 0;
            self.next_seq = Some(start_seq.wrapping_add(data.len() as u32));
            return Some(data.to_vec());
        }

        let mut cursor = self.next_seq.unwrap();
        let mut output: Vec<u8> = Vec::new();

        while let Some(mut segment) = self.cache.remove(&cursor) {
            self.buffered_bytes -= segment.len();
            cursor = cursor.wrapping_add(segment.len() as u32);
            if output.is_empty() {
                output = std::mem::take(&mut segment);
            } else {
                output.extend_from_slice(&segment);
            }
        }

        if output.is_empty() {
            None
        } else {
            self.next_seq = Some(cursor);
            Some(output)
        }
    }

    pub fn reset(&mut self, next_seq: Option<u32>) {
        self.cache.clear();
        self.buffered_bytes = 0;
        self.next_seq = next_seq;
    }

    pub fn next_sequence(&self) -> Option<u32> {
        self.next_seq
    }
}

pub struct BinaryReader {
    pub cursor: Cursor<Vec<u8>>,
}

impl BinaryReader {
    pub fn from(data: Vec<u8>) -> Self {
        Self { cursor: Cursor::new(data) }
    }

    pub fn read_u16(&mut self) -> io::Result<u16> {
        self.cursor.read_u16::<BigEndian>()
    }

    pub fn read_u32(&mut self) -> io::Result<u32> {
        self.cursor.read_u32::<BigEndian>()
    }

    pub fn peek_u32(&mut self) -> io::Result<u32> {
        let pos = self.cursor.position();
        let value = self.cursor.read_u32::<BigEndian>()?;
        self.cursor.set_position(pos);
        Ok(value)
    }

    pub fn read_u64(&mut self) -> io::Result<u64> {
        self.cursor.read_u64::<BigEndian>()
    }

    pub fn read_bytes(&mut self, count: usize) -> io::Result<Vec<u8>> {
        let mut buffer = vec![0u8; count];
        self.cursor.read_exact(&mut buffer)?;
        Ok(buffer)
    }

    pub fn read_remaining(&mut self) -> &[u8] {
        let pos = self.cursor.position() as usize;
        let buf = self.cursor.get_ref();
        &buf[pos..]
    }

    pub fn remaining(&self) -> usize {
        let total = self.cursor.get_ref().len() as u64;
        let pos = self.cursor.position();
        total.saturating_sub(pos) as usize
    }
}
