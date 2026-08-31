/**
 * Codeforces 风格 Rating 段位：根据 rating 与对局数给出颜色 class 与称号。
 */
export interface RatingTier {
  className: string;
  title: string;
}

export const ratingTier = (rating: number, ratingGames: number): RatingTier => {
  if (!Number.isFinite(rating) || !Number.isFinite(ratingGames) || ratingGames <= 0) {
    return { className: 'rt-unrated', title: 'Unrated' };
  }
  if (rating < 1200) {
    return { className: 'rt-gray', title: 'Newbie' };
  }
  if (rating < 1400) {
    return { className: 'rt-green', title: 'Pupil' };
  }
  if (rating < 1600) {
    return { className: 'rt-cyan', title: 'Specialist' };
  }
  if (rating < 1900) {
    return { className: 'rt-blue', title: 'Expert' };
  }
  if (rating < 2100) {
    return { className: 'rt-violet', title: 'Candidate Master' };
  }
  if (rating < 2400) {
    return { className: 'rt-orange', title: 'Master' };
  }
  return { className: 'rt-red', title: 'Grandmaster' };
};
