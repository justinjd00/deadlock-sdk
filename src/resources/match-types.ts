/**
 * Match metadata types. The API's OpenAPI spec types this response as a bare
 * `object`, so these are written by hand from real responses. Every object
 * stays open (`[key: string]: unknown`) because Valve adds fields with patches.
 */

export interface MatchItemEvent {
  /** Seconds into the match when it was bought. */
  game_time_s: number;
  /** Matches `Item.id` from the item assets. */
  item_id: number;
  upgrade_id?: number;
  /** `0` when never sold. */
  sold_time_s: number;
  flags?: number;
  imbued_ability_id?: number;
  [key: string]: unknown;
}

/** Snapshot of a player's stats at a point in time. The last one is the final state. */
export interface MatchPlayerStatSnapshot {
  time_stamp_s: number;
  net_worth: number;
  kills: number;
  deaths: number;
  assists: number;
  creep_kills?: number;
  neutral_kills?: number;
  player_damage?: number;
  player_damage_taken?: number;
  boss_damage?: number;
  player_healing?: number;
  shots_hit?: number;
  shots_missed?: number;
  [key: string]: unknown;
}

export interface MatchAccolade {
  accolade_id: number;
  accolade_stat_value: number;
  accolade_threshold_achieved: number;
  [key: string]: unknown;
}

export interface MatchPlayerRankData {
  initial_display_rank?: number;
  initial_flat_progress?: number;
  final_flat_progress?: number;
  desired_progress_change?: number;
  [key: string]: unknown;
}

export interface MatchPlayer {
  account_id: number;
  player_slot: number;
  /** `0` or `1`, compare with `MatchInfo.winning_team`. */
  team: number;
  hero_id: number;
  kills: number;
  deaths: number;
  assists: number;
  net_worth: number;
  last_hits: number;
  denies: number;
  level: number;
  ability_points?: number;
  assigned_lane?: number;
  abandon_match_time_s?: number;
  /** 1 = win, 2 = loss as seen in real data. Prefer comparing `team` to `winning_team`. */
  player_match_outcome?: number;
  mvp_rank?: number | null;
  items: MatchItemEvent[];
  stats: MatchPlayerStatSnapshot[];
  accolades?: MatchAccolade[];
  player_rank_data?: MatchPlayerRankData | null;
  [key: string]: unknown;
}

export interface MatchObjective {
  destroyed_time_s: number;
  team?: number;
  team_objective?: number;
  team_objective_id?: number;
  creep_damage?: number;
  player_damage?: number;
  first_damage_time_s?: number;
  [key: string]: unknown;
}

export interface MatchInfo {
  match_id: number;
  /** Unix seconds. */
  start_time: number;
  duration_s: number;
  /** `0` or `1`. */
  winning_team: number;
  match_outcome: number;
  game_mode: number;
  match_mode: number;
  average_badge_team0?: number | null;
  average_badge_team1?: number | null;
  is_high_skill_range_parties?: boolean;
  low_pri_pool?: boolean;
  new_player_pool?: boolean;
  not_scored?: boolean;
  objectives_mask_team0?: number;
  objectives_mask_team1?: number;
  players: MatchPlayer[];
  objectives?: MatchObjective[];
  mid_boss?: Array<{
    team_killed: number;
    team_claimed: number;
    destroyed_time_s: number;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface MatchMetadata {
  match_info: MatchInfo;
  hero_build_ids?: unknown;
  pregame_hero_ids?: unknown;
  banned_hero_ids?: number[] | null;
  [key: string]: unknown;
}
