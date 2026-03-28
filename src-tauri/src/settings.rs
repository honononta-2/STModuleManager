use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    /// 起動時にネットワーク監視を自動開始するか
    pub auto_monitor: bool,
    /// 監視開始時に確認モーダルを表示するか
    pub show_monitor_confirm: bool,
    /// テーマ設定: "light", "dark", "system"
    #[serde(default = "default_theme")]
    pub theme: String,
    /// 言語設定: "ja", "ko", "en", "custom"
    #[serde(default = "default_language")]
    pub language: String,
    /// 初回言語選択モーダルを完了したか
    #[serde(default)]
    pub language_configured: bool,
}

fn default_theme() -> String {
    "system".to_string()
}

fn default_language() -> String {
    "ja".to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            auto_monitor: false,
            show_monitor_confirm: true,
            theme: default_theme(),
            language: default_language(),
            language_configured: false,
        }
    }
}

pub struct AppSettingsState {
    pub settings: Mutex<AppSettings>,
    pub path: PathBuf,
}

impl AppSettingsState {
    pub fn new(path: PathBuf) -> Self {
        let settings = if path.exists() {
            std::fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            AppSettings::default()
        };
        Self {
            settings: Mutex::new(settings),
            path,
        }
    }

    pub fn save(&self) -> Result<(), String> {
        let settings = self.settings.lock().map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(&*settings).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, json).map_err(|e| e.to_string())?;
        Ok(())
    }
}
