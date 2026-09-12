import type { Lineup, LineupSlot, PlayerMatchStat, Role } from '@fantacomics/core';
import { PlayerMatchStatSchema } from '@fantacomics/core';

export function mkStat(
  playerId: string,
  role: Role,
  vote: number | null,
  events: Partial<PlayerMatchStat['events']> = {},
  extra: Partial<PlayerMatchStat> = {},
): PlayerMatchStat {
  return PlayerMatchStatSchema.parse({
    playerId,
    playerName: playerId,
    role,
    serieATeam: 'TST',
    vote,
    minutes: vote === null ? 0 : 90,
    events,
    ...extra,
  });
}

export function slot(playerId: string, role: Role): LineupSlot {
  return { playerId, role };
}

export function mkLineup(
  teamId: string,
  starters: LineupSlot[],
  bench: LineupSlot[] = [],
  extra: Partial<Lineup> = {},
): Lineup {
  const d = starters.filter((s) => s.role === 'D').length;
  const c = starters.filter((s) => s.role === 'C').length;
  const a = starters.filter((s) => s.role === 'A').length;
  return {
    teamId,
    module: `${d}-${c}-${a}`,
    starters,
    bench,
    captainId: null,
    viceCaptainId: null,
    autoFilled: false,
    ...extra,
  };
}

/** Un 3-4-3 standard: p1 portiere, d1..d3, c1..c4, a1..a3. */
export function standard343(teamId = 'T1', bench: LineupSlot[] = []): Lineup {
  return mkLineup(
    teamId,
    [
      slot('p1', 'P'),
      slot('d1', 'D'), slot('d2', 'D'), slot('d3', 'D'),
      slot('c1', 'C'), slot('c2', 'C'), slot('c3', 'C'), slot('c4', 'C'),
      slot('a1', 'A'), slot('a2', 'A'), slot('a3', 'A'),
    ],
    bench,
  );
}
