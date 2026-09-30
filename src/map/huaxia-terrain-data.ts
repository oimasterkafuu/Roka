/**
 * 华夏离线地貌数据（归一化坐标：x=北→南，y=西→东）。
 *
 * 数据参照 Natural Earth 1:10m Physical 的 coastline/land 轮廓、公开
 * DEM（SRTM/ASTER GDEM）山脊观察，以及中国历史地图中的山口位置。
 * 这里保存的是人工审阅后的轻量折线与掩膜，不是原始 GIS 数据：离线
 * 转换时舍弃了海岸线的细节，并为方格游戏保留平原、山系层次和通道。
 * 因此它是可审计的游戏化近似，不能当作测绘或历史疆域复原。
 */

export interface HuaxiaPoint {
  x: number;
  y: number;
}

export interface HuaxiaRidge {
  name: string;
  width: number;
  points: readonly HuaxiaPoint[];
}

export interface HuaxiaPass {
  name: string;
  x: number;
  y: number;
  radius: number;
}

/** 中国主体（含沿海平原）的简化轮廓，海岸外侧统一为海域。 */
export const HUAXIA_LAND_OUTLINE: readonly HuaxiaPoint[] = [
  { x: 0.03, y: 0.12 },
  { x: 0.03, y: 0.32 },
  { x: 0.1, y: 0.53 },
  { x: 0.16, y: 0.58 },
  { x: 0.2, y: 0.66 },
  { x: 0.25, y: 0.7 },
  { x: 0.31, y: 0.76 },
  { x: 0.39, y: 0.82 },
  { x: 0.47, y: 0.86 },
  { x: 0.55, y: 0.88 },
  { x: 0.62, y: 0.86 },
  { x: 0.68, y: 0.82 },
  { x: 0.72, y: 0.76 },
  { x: 0.79, y: 0.7 },
  { x: 0.84, y: 0.64 },
  { x: 0.86, y: 0.57 },
  { x: 0.82, y: 0.51 },
  { x: 0.77, y: 0.46 },
  { x: 0.73, y: 0.41 },
  { x: 0.68, y: 0.36 },
  { x: 0.61, y: 0.31 },
  { x: 0.54, y: 0.25 },
  { x: 0.47, y: 0.2 },
  { x: 0.39, y: 0.16 },
  { x: 0.31, y: 0.12 },
  { x: 0.24, y: 0.1 },
  { x: 0.14, y: 0.08 },
  { x: 0.08, y: 0.08 },
];

/** 海湾、近海与东南海域的固定掩膜；坐标均位于主体轮廓之外。 */
export const HUAXIA_SEA_BAYS: readonly (readonly HuaxiaPoint[])[] = [
  [
    { x: 0.66, y: 0.81 },
    { x: 0.73, y: 0.86 },
    { x: 0.81, y: 0.9 },
    { x: 0.88, y: 0.87 },
    { x: 0.84, y: 0.8 },
    { x: 0.76, y: 0.77 },
  ],
  [
    { x: 0.72, y: 0.72 },
    { x: 0.8, y: 0.76 },
    { x: 0.87, y: 0.72 },
    { x: 0.9, y: 0.65 },
    { x: 0.84, y: 0.62 },
    { x: 0.77, y: 0.66 },
  ],
];

/** 主脉 width 大于支脉 width；折线为栅格化前的中心线。 */
export const HUAXIA_RIDGES: readonly HuaxiaRidge[] = [
  {
    name: '天山',
    width: 0.035,
    points: [
      { x: 0.18, y: 0.12 },
      { x: 0.2, y: 0.25 },
      { x: 0.18, y: 0.38 },
    ],
  },
  {
    name: '昆仑—祁连',
    width: 0.045,
    points: [
      { x: 0.3, y: 0.08 },
      { x: 0.34, y: 0.24 },
      { x: 0.4, y: 0.39 },
      { x: 0.46, y: 0.53 },
    ],
  },
  {
    name: '阴山—燕山',
    width: 0.04,
    points: [
      { x: 0.17, y: 0.4 },
      { x: 0.16, y: 0.54 },
      { x: 0.2, y: 0.68 },
      { x: 0.24, y: 0.77 },
    ],
  },
  {
    name: '太行',
    width: 0.032,
    points: [
      { x: 0.24, y: 0.59 },
      { x: 0.3, y: 0.6 },
      { x: 0.38, y: 0.59 },
      { x: 0.45, y: 0.61 },
    ],
  },
  {
    name: '秦岭',
    width: 0.04,
    points: [
      { x: 0.43, y: 0.38 },
      { x: 0.47, y: 0.49 },
      { x: 0.51, y: 0.61 },
      { x: 0.54, y: 0.72 },
    ],
  },
  {
    name: '横断',
    width: 0.045,
    points: [
      { x: 0.42, y: 0.27 },
      { x: 0.52, y: 0.31 },
      { x: 0.61, y: 0.36 },
      { x: 0.69, y: 0.42 },
    ],
  },
  {
    name: '南岭',
    width: 0.037,
    points: [
      { x: 0.61, y: 0.38 },
      { x: 0.64, y: 0.52 },
      { x: 0.67, y: 0.68 },
      { x: 0.71, y: 0.79 },
    ],
  },
  {
    name: '武夷',
    width: 0.028,
    points: [
      { x: 0.55, y: 0.72 },
      { x: 0.63, y: 0.75 },
      { x: 0.72, y: 0.76 },
      { x: 0.79, y: 0.74 },
    ],
  },
  {
    name: '阿尔泰—大兴安岭',
    width: 0.026,
    points: [
      { x: 0.05, y: 0.31 },
      { x: 0.1, y: 0.46 },
      { x: 0.17, y: 0.61 },
      { x: 0.26, y: 0.72 },
    ],
  },
  {
    name: '贺兰山支脉',
    width: 0.018,
    points: [
      { x: 0.2, y: 0.42 },
      { x: 0.29, y: 0.47 },
      { x: 0.38, y: 0.5 },
    ],
  },
  {
    name: '雪峰—罗霄支脉',
    width: 0.018,
    points: [
      { x: 0.58, y: 0.54 },
      { x: 0.64, y: 0.63 },
      { x: 0.7, y: 0.7 },
    ],
  },
];

export const HUAXIA_PASSES: readonly HuaxiaPass[] = [
  { name: '河西走廊', x: 0.31, y: 0.31, radius: 0.055 },
  { name: '潼关', x: 0.46, y: 0.55, radius: 0.045 },
  { name: '函谷关', x: 0.48, y: 0.61, radius: 0.04 },
  { name: '雁门关', x: 0.25, y: 0.58, radius: 0.04 },
  { name: '剑门关', x: 0.51, y: 0.39, radius: 0.04 },
  { name: '梅关', x: 0.67, y: 0.72, radius: 0.04 },
  { name: '夷陵通道', x: 0.56, y: 0.66, radius: 0.04 },
];

export const HUAXIA_REGION_OFFSETS: Readonly<Record<string, number>> = {
  han: 0,
  'three-kingdoms': 1,
  'northern-dynasties': 2,
  tang: 3,
  song: 4,
  yuan: 5,
  ming: 6,
  qing: 7,
};
