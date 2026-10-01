import { MAX_TEAMS, MapRegion } from '../types';

const TAIWAN_MAP_SIZE_MULTIPLIER = 1.5;

const resolveMapSizeRatioByPlayers = (playingCount: number): number => {
  const minPlayers = 2;
  const maxPlayers = MAX_TEAMS;
  const clampedPlayingCount = Math.max(minPlayers, Math.min(maxPlayers, playingCount));
  const x = clampedPlayingCount - minPlayers;
  const ratio = 0.34 + 0.1067857143 * x - 0.0030357143 * x * x;
  return Math.max(0.34, ratio);
};

const resolveMapSizeRatioByPlayersAndRegion = (playingCount: number, mapRegion: MapRegion): number => {
  const ratio = resolveMapSizeRatioByPlayers(playingCount);
  return mapRegion === 'taiwan' ? ratio * TAIWAN_MAP_SIZE_MULTIPLIER : ratio;
};

export { resolveMapSizeRatioByPlayers, resolveMapSizeRatioByPlayersAndRegion };
