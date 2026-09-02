const LEFT_GAME = 52;
const AFK_MIN_TURNS = 60;
const AFK_MIN_MS = 60_000;

/**
 * 网络掉线宽限期：玩家 socket 断开后 10 秒（1 倍速 = 20 Tick）内重连可恢复对局，
 * 期间不判挂机、不投降；超时以「挂机」原因自动投降。
 */
const DISCONNECT_GRACE_MS = 10_000;

/**
 * 孤军衰减比例（基于当前兵力，最低减 1）。宽限期结束后每回合（2 Tick）结算一次。
 */
const ISOLATED_DECAY_RATIO = 0.05;

/**
 * 断链宽限期：前 5 回合（10 Tick）只快速闪烁提示，不真正衰减。
 */
const ISOLATED_GRACE_TICKS = 10;

export {
  LEFT_GAME,
  AFK_MIN_TURNS,
  AFK_MIN_MS,
  ISOLATED_DECAY_RATIO,
  ISOLATED_GRACE_TICKS,
  DISCONNECT_GRACE_MS,
};
