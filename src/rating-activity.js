/** Zero is the durable sentinel for no trustworthy rated-game evidence. */
const isValidLastGameAt = (value, now) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= now;

/** Pure migration: never infer a game from account activity or alter valid existing values. */
const deriveLastGameAt = (user, now) => {
  if (isValidLastGameAt(user.lastGameAt, now)) return { value: user.lastGameAt, source: 'valid' };
  let latest = 0;
  if (Array.isArray(user.ratingHistory)) {
    for (const point of user.ratingHistory) {
      if (
        point &&
        typeof point === 'object' &&
        typeof point.t === 'number' &&
        Number.isFinite(point.t) &&
        point.t > 0 &&
        point.t <= now &&
        typeof point.r === 'number' &&
        Number.isFinite(point.r)
      )
        latest = Math.max(latest, point.t);
    }
  }
  return { value: latest, source: latest > 0 ? 'history' : 'none' };
};

module.exports = { isValidLastGameAt, deriveLastGameAt };
