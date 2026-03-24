/// ゲームプロトコルのフラグメントタイプ
#[repr(u16)]
#[non_exhaustive]
#[derive(Debug)]
pub enum FragmentType {
    None = 0,
    Call = 1,
    Notify = 2,
    Return = 3,
    Echo = 4,
    FrameUp = 5,
    FrameDown = 6,
}

impl From<u16> for FragmentType {
    fn from(v: u16) -> Self {
        match v {
            0 => FragmentType::None,
            1 => FragmentType::Call,
            2 => FragmentType::Notify,
            3 => FragmentType::Return,
            4 => FragmentType::Echo,
            5 => FragmentType::FrameUp,
            6 => FragmentType::FrameDown,
            _ => FragmentType::None,
        }
    }
}
