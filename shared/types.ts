export interface StatEntry {
  part_id: number;
  value: number;
}

/** 最適化に渡すモジュールデータ（Desktop/Web共通） */
export interface ModuleInput {
  uuid: number;
  config_id: number | null;
  quality: number | null;
  stats: StatEntry[];
}

/** 探索スピードモード: "standard"=標準(200件), "precise"=高精度(300件), "most_precise"=最高精度(600件), "exhaustive"=総当たり */
export type SpeedMode = "standard" | "precise" | "most_precise" | "exhaustive";

export interface OptimizeRequest {
  required_stats: number[];
  desired_stats: number[];
  excluded_stats: number[];
  min_quality: number;
  speed_mode?: SpeedMode;
  worker_id?: number;
  num_workers?: number;
  /** ステータス最低値制約: part_id → 最低合計値 (例: {1110: 20, 1205: 16}) */
  min_thresholds?: Record<number, number>;
  /** カウントのみモード: フィルタ後の候補数だけ返す */
  count_only?: boolean;
}

export interface OptimizeResponse {
  combinations: Combination[];
  filtered_count: number;
  total_modules: number;
}

export interface Combination {
  rank: number;
  modules: CombinationModule[];
  stat_totals: StatTotal[];
  score: number;
  total_plus: number;
}

export interface CombinationModule {
  uuid: number;
  quality: number | null;
  stats: StatEntry[];
}

export interface StatTotal {
  part_id: number;
  total: number;
  breakpoint: string;
  breakpoint_score: number;
  is_required: boolean;
  is_desired: boolean;
}
