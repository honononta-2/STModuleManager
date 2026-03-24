export interface StatEntry {
  part_id: number;
  value: number;
}

export interface ModuleEntry {
  uuid: number;
  config_id: number | null;
  quality: number | null;
  stats: StatEntry[];
  success_rate: number | null;
  equipped_slot: number | null;
  acquired_date: string; // "YYYY-MM-DDTHH:MM:SS"
}
