# Roka 实时介绍片

当前版本为 124 秒、19 段镜头。它在浏览器中使用 WebGL2 绘制三维场景，Canvas 2D 合成实机棋盘、字幕、背景、左右对照及片尾。没有下载或播放整段 MP4，也没有在本轮制作新的导出视频。

## 已接入的行为

首次打开首页时，在已有通知权限提示结束后询问是否观看。弹窗显示即记录 `localStorage.roka_intro_offered_v1=1`，观看、拒绝、Escape、关闭均不再自动询问。存储被浏览器禁用时仅能在当前页面生命周期内记住选择。「关于」中的重播按钮始终可用，不重置一次性标记。

同意之前只载入轻量入口 JS/CSS。点击观看才动态导入播放器并请求模型、材质、字体、回放和音乐。选择观看时在原始点击事件内立即请求浏览器全屏，加载和播放都使用没有卡片边框的全屏舞台；浏览器拒绝或不支持全屏时使用铺满页面的同款界面。控件在播放时自动隐藏，指针、触摸或键盘操作、暂停和出错时重新显示。播放器支持暂停/继续、静音、进度跳转、结束后重播和随时关闭。标签页隐藏会暂停，显示后恢复；手动暂停不会被显示事件覆盖。退出时取消 RAF、网络请求和未完成的播放操作，释放骨架/几何/材质/贴图、WebGL 上下文、音频节点、图片位图及临时画布。出错可以重试，播放中渲染失败也会停止音乐。

舞台逻辑构图恒为 1920×1080，整个内容按 16:9 等比缩放，不按屏幕改变相机或裁剪范围。实时播放时，Canvas 2D 与 WebGL 的 backing store 均为各自实际 CSS 显示尺寸乘以当前 devicePixelRatio，二维绘制通过 transform 保持原逻辑坐标；窗口 resize、显示区域和 DPR 变化会同步尺寸并重绘当前帧，不改变播放进度。三维后处理目标同步使用物理分辨率，metrics 的 internalWidth/internalHeight 如实反映当前值。离线图帧、视频导出及独立 Canvas 基准仍默认使用原 1600×900 三维源画布和 1920×1080 合成。不同 GPU 的像素与帧率可能不同。镜头、模型、材质、色调映射、2048 阴影、动作和时间轴保持同一套参数，没有为手机切换成另一套低画质镜头。

## 本轮视觉修改

- 隔离区域采用原生快速/常速透明度闪烁：宽限期 0.4 秒周期，衰减期 1 秒周期，半周期透明度 0.45，由全片时钟驱动；低亮度相位淡出到白色（先铺不透明白底再半透明绘制，与游戏本体在白底页面上的视觉效果一致）；去掉黄色隔离描边。
- 冲刺后新增 4 秒铺满画面的左右对照，左半屏三维冲锋、右半屏放大真实回放，中间只有一条竖线，不使用黑底或卡片边框；放大的地图按显示尺寸绘制文字和图标，避免小位图放大的模糊。Y5bAFF7R2i8s 的 628–638 tick 中，蓝军在 632、634、636 tick 沿第 15 行向东推进并占领红格。视窗固定，不追随单位抖动，不显示玩家或算法名称。
- 升空过程中保留山体和投影，直接交融原生棋盘，移除遮挡转场的云雾。施工阶段的敲击、火花与烟尘保留。三维为概念演绎，二维为游戏实际画面，没有把这种转场包装成游戏功能。
- 142 个山格有不同的峰高、轮廓、走向和侵蚀细节，70 处相邻连接形成连续山脊；54 处湿地使用变化的盆地/岸线、泥土、暗色浅水、非规则微波、芦苇与睡莲。避免重复复制同一山/水塘。
- 棋盘段落复用早期宣传片的军队与战马图片，叠加暗色层；地图本身继续使用原生配色和透明图标。
- 结尾保留完整 `https://roka.oim.moe:444` 与二维码。

## 效率与数据

模型保持原有几何与动画：hero 49,624、mid 16,055、crowd 3,378 个三角形。使用 Meshopt 无损缓冲压缩与顶点/索引重排，没有量化变更顶点属性；原始三角面逐一比对及动画通道比对均通过。hero / mid 的重复贴图使用同一哈希文件。材质和阴影参数保留。

建筑按材质合批，阶段排序后通过 `drawRange` 逐层显示，每栋建筑主体最多 4 次绘制；远景同款城堡共享几何缓冲。水边植被采用实例绘制；相邻水格的网格角点取样复用；静态远景兵员只求值一次姿态。近景继续执行世界坐标落脚锁定和接地 IK。三维画布与字幕/棋盘画布分层交给浏览器合成，避免每帧把 WebGL 画布复制进 Canvas 2D；冲刺对照通过左半屏的独立三维图层呈现。渲染时不启用 `preserveDrawingBuffer`，不输出 JPEG。只有片尾静态背景首次创建时复制一次三维画面，不做 GPU→CPU 的逐帧图片读回。

实机棋盘缓存不变地块和数字字形，只更新变化/闪烁格。回放为增量数组及定期检查点，支持前进和任意跳转，不需要在观看时启动游戏服务器或运行 16 个 AI。原片 16 方模拟与公开回放的显示快照已保留，姓名、用户标识和机器人名称不进入素材。

音乐延续原片配乐/音效，88 秒处复用前一段 4 秒冲锋音乐以覆盖新增对照段。192 kbps MP3 约 2.98 MB，浏览器一次解码。统一时间轴跟随 Web Audio 时钟；画面目标 30 fps，性能不足时跳过画面帧以保持音乐、镜头与回放时序，不累计动画增量。无音频能力时可静音观看。

入口版本随站点版本更新。模型、贴图等文件名携带 SHA-256 前 16 位，缓存一年且 immutable。可变的 `manifest.json` 每次仍经 `ROKA_ASSETS` 网络与 CDN 回退链获取，不写入 Cache Storage；`/intro/assets/` 下文件名携带 16 位内容哈希的模型、贴图、HDR、音频、图片、字体、JSON 及 glTF 外部依赖，统一通过 `roka-intro-assets-v1` Cache Storage 做 cache-first 持久复用，缓存键使用应用源规范 URL，与本次 CDN provider 无关。缓存不可用或读写失败时继续走网络。JSON/GLTF/模型缓冲/HDR/播放器使用预生成 gzip/Brotli 副本，服务端不实时压缩。不使用外部 CDN 或第三方运行时。

冷启动完整播放资源实测约 18.3 MB（含约 2.98 MB 音轨），相对原 78.3 MB 成片减少约 77%；同一浏览器重播及后续页面生命周期复用哈希素材的 Cache Storage 与不可变 HTTP 缓存。独立 Canvas 测试将棋盘的离屏缓存移到 CPU 后，普通棋盘 / 16 方棋盘 / 对照画面的原布局热帧平均耗时从约 29 / 64 / 31 ms 降至 3.82 / 4.64 / 3.0 ms；最终半屏铺满布局重新测试为 3.54 / 4.49 / 4.45 ms，16 方首次准备为 30.5 ms。这个测试不含 WebGL 或音频，并在每帧刷新 Canvas，避免把命令提交时间误认为绘制完成时间。CPU 与 GPU 缓存路径的像素平均通道误差约 0.46–0.57/255，构图、文字和时序一致。

性能记录见 [intro-performance.json](intro-performance.json)。当前云端仅有 CPU / SwiftShader 软件图形，完整播放器测试出现低帧率与 GPU 排队长停顿，软件渲染环境未达到流畅播放目标；不能据此认定移动设备或真实 GPU 达到 30 fps；发布前应在实际目标设备确认帧率与温度。没有用降低材质、分辨率或改动镜头来掩盖这一限制。

## 构建与验证

使用仓库声明的 Corepack / pnpm 版本：

```sh
pnpm install --frozen-lockfile
pnpm run lint
pnpm run format
pnpm run build
pnpm run test:intro
pnpm run test:guest-access
pnpm run test:asset-versioning
```

正常构建完全使用仓库素材，`scripts/intro/build-intro.mjs` 以 esbuild 打包播放器并创建预压缩副本，不调用 Blender/FFmpeg，不访问旧制作工程或网络。`player.js` 为构建产物，修改源码后应重新构建。

额外浏览器测试：

```sh
ROKA_PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-intro-entry.mjs
# 本地服务启动后，实际入口/音频/渲染/流量性能探测，仅保存一张页面截图与 JSON：
ROKA_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs ROKA_INTRO_BASE=http://127.0.0.1:23333 node scripts/intro/benchmark-intro.mjs
```

额外的 `scripts/intro/benchmark-intro-canvas.mjs` 可独立检查棋盘缓存绘制耗时。

便携回放测试用原始快照的 SHA-256 摘要检查 1,402 次完整状态重建，含反向和大跨度跳转。若本机有备份制作工程，可再作原数据/无损模型交叉核对：

```sh
node scripts/intro/test-intro-data.mjs static/intro/assets /path/to/roka-trailer
node scripts/intro/test-intro-models.mjs /path/to/roka-trailer
```

`scripts/intro/import-intro-assets.mjs`、`prepare-intro-media.py`、`build-intro-data.mjs`、`build-intro-fonts.py` 是开发期素材准备工具。它们依赖备份制作工程，不属于正常站点构建。字体工具使用安装了 fonttools/Brotli 的 Python。修改回放源或时间轴后，应同步更新校验摘要；不要只改摘要绕过不一致。

## 来源与许可

- 士兵：Grab3D [Armored Knight](https://grab3d.com/models/characters/armored-knight/)，CC0；原模型的行走/跑步动画，接地、待命与指挥动作由本项目代码处理，无新增手持武器。
- Poly Haven，CC0：[rock_face_03](https://polyhaven.com/a/rock_face_03)、[medieval_blocks_03](https://polyhaven.com/a/medieval_blocks_03)、[slate_floor_02](https://polyhaven.com/a/slate_floor_02)、[wood_planks_grey](https://polyhaven.com/a/wood_planks_grey)、[rocky_terrain_02](https://polyhaven.com/a/rocky_terrain_02)、[brown_mud_02](https://polyhaven.com/a/brown_mud_02)、[kloofendal_48d_partly_cloudy](https://polyhaven.com/a/kloofendal_48d_partly_cloudy)。[CC0 许可](https://polyhaven.com/license)。
- 音效：Kenney Impact Sounds，CC0；配乐为此前宣传片流程生成的原始编曲。背景复用此前为本项目生成的宣传图片。
- 三维/合成代码与程序建筑、地形：本项目；游戏图标与公开回放：ROKA。浏览器数据去除玩家身份信息。
- Three.js，MIT；Meshoptimizer，MIT。Noto 字体与 Quicksand，SIL OFL；DejaVu，Bitstream Vera / DejaVu 许可。相关许可全文保存在 `static/intro/licenses/`。

## 备份与源码基线

修改网站前已独立备份原 120 秒 V4 成片及制作脚本。视频 SHA-256：`25a80dbc65b56218d4d1495db33ddefa244636be4ea41ff71adaa67e8c33dbee`。本机备份目录：`/workspace/roka-backups/20261023T151343Z/`；旧制作工程保留在 `/workspace/roka-trailer/`。

网站代码重新从远端 `main` 克隆，基线 `d0b6635bb3b20044596cc4704228a70c641b05b0` / v1.69.9，功能分支 `feat/client-rendered-intro`，目标 v1.70.0。没有改动旧的游戏工作区。成片和离线 CG 帧不进入网站仓库。
