# 逐文件固定提交的静态资源 CDN

## 路径与版本

生产路径为 `https://testingcf.jsdelivr.net/gh/oimasterkafuu/Roka@<文件最后修改的 40 位 SHA>/static/<文件>`。服务启动时一次 `git ls-files -z` 、一次 `git log --name-only -z` 及浅克隆边界查询 建立已跟踪路径到最后修改提交的映射，请求期间不调用 Git、不启动 watcher。文件 A 的修改不会改变 B 的 CDN URL；package version 的改变同样不会改变未修改文件的 URL。

CDN 地址移除全局 `v` query，保留其他 query 与 hash。例如旧版 `/Roka@<静态树 SHA>/static/crown.png?v=2.0.1` 改为 `/Roka@<crown.png 最后修改 SHA>/static/crown.png`，更新 main.js 或版本号后该地址不变。最后的本站回退仍保留原始 query，保持原有模板注入、ETag 与本地缓存语义。

HTML、preload、有序脚本描述、运行时 `ROKA_ASSETS.url/fetch/import` 和 Worker 实现均查自己的 pathname。各提供方使用该文件同一 SHA；preload 与实际脚本请求完全一致。CSS 入口由运行时带 SRI 下载，然后递归解析 `@import` 和 `url()`：嵌套样式、字体及图片分别查询自身 SHA，通过同一故障切换 fetch 下载后生成页面生命周期内复用的 blob URL。这样浏览器不会把相对依赖错误地绑定到父 CSS 的提交；样式 link 顺序和属性保留，脚本队列等待样式完成。首屏在内联同背景加载提示下等待初始样式，样式完成即展示，不等待脚本队列。整个 CSS 依赖图超过 4 秒（包括正文、字体和图片等待）或失败时，当前 link 改用保留原 query 的同源原生 CSS，并保留入口 SRI；此降级路径的嵌套依赖由浏览器同源解析。再等待最多 8 秒后解除提示并让 ready 报错，避免永久遮挡；同源也失败时无法保证完整样式。迟到 CDN 结果不会覆盖同源 link。CSS 依赖并行预取，共享 CSS 素材只下载一次，blob 随页面销毁释放。不要直接把未处理的 CDN CSS URL 放进动态 link；动态样式应调用 `ROKA_ASSETS.stylesheet(path, integrity, attrs)`。

介绍片 manifest、哈希素材及 glTF buffer/image 依赖沿用现有 loader，每次请求经逐文件运行时解析，模型内部依赖转换成可释放 blob URL。播放器由构建脚本打包，不包含浏览器需要解析的相对模块导入。项目当前没有独立 Web Worker；Service Worker 使用下述同源装载器。

默认候选依次为 `testingcf.jsdelivr.net`、`cdn.jsdmirror.com`、`cdn.jsdmirror.cn`、本站。后两个属于同一运营方。2026-10-30 本机全新浏览器上下文的直连与显式代理对照中，镜像双域对真实逐文件 SHA 持续返回 521（另有 429），独立源的 CSS 请求成功，因此调整顺序；这不代表独立源在所有网络可用，脚本请求仍观察到超时。只在请求失败、非成功 HTTP 状态或脚本/入口 CSS 完整性校验失败后切换。入口脚本通过 preload 并行下载，再按依赖顺序执行，不用超时重插方式冒险重复执行；素材 fetch 等待响应头每个源最多 8 秒，使用者取消时立即停止且不切换。模型依赖先经 CDN 下载为可释放的 blob URL，共享贴图只取一次。

HTML 仍由本站动态生成，以保留认证与会话凭据；`/api/`、`/socket.io/`、导航路径不改写。浏览器要求 Service Worker 注册入口同源，因此 `/sw.js?v=<站点版本>` 仅返回小型装载器，通过 `importScripts` 获取固定版本的 CDN 实现。最后回退 `/sw.js?source=1` 为原实现，避免递归。没有上传或下载整段 MP4，介绍片由用户同意后按需加载静态素材并在客户端实时绘制。

脚本与入口 CSS 的 SHA-384 由部署的本地文件计算，浏览器校验后执行/应用；嵌套 CSS、字体、图片与模型使用固定提交地址和 HTTPS。不要用 CDN 地址包裹登录页、API 或用户凭据。

## 配置与开发

| 变量                      | 行为                                                            |
| ------------------------- | --------------------------------------------------------------- |
| `ROKA_STATIC_CDN=0`       | 显式禁用，离线开发使用本站静态文件                              |
| `ROKA_STATIC_CDN=1`       | 启用（默认）；生产应使用已提交的资源版本                        |
| `ROKA_STATIC_COMMIT`      | 全文件强制覆盖为完整 40 位十六进制 SHA；用于归档部署或回滚      |
| `ROKA_STATIC_CDN_ORIGINS` | 逗号分隔的裸 HTTPS origin；测试允许 localhost/127.0.0.1 的 HTTP |

开发模式 `pnpm run dev` 显式设置 `ROKA_STATIC_CDN=0`，本地编辑直接生效。其他启动方式只要有有效提交即默认启用 CDN；不会因压缩副本或未跟踪文件关闭整个 CDN；未跟踪或无法确定 SHA 的文件单独使用本站，不伪造版本。已跟踪文件的未提交修改仍对应已提交版本，开发时必须关闭 CDN，生产部署应保持源码与历史一致。缺少 Git 历史且未指定 SHA 时全部使用本站。CDN 故障时最后可使用本站文件，生产源码与指定素材 SHA 必须一致。

发布流程：构建并校验 → 推送功能提交 → 按各文件 SHA 预热入口 JS/CSS、manifest、模型与音乐 → 合并并推送 main → 检查线上 HTML 中的逐文件映射 与 `/api/version`。不要固定一个过期 SHA，也不要改为浮动分支名。仓库需可公开读取；私有仓库应改用自管 CDN，不将访问令牌放入前端。

## 中国大陆检测与限制

2026-10-24 对项目真实文件使用完整 SHA，从 Globalping 中国大陆探针抽样：

| CDN    | 电信        | 联通        | 移动        | HTTP   |
| ------ | ----------- | ----------- | ----------- | ------ |
| `.com` | 南京 334 ms | 南宁 190 ms | 上海 359 ms | 均 200 |
| `.cn`  | 桂林 413 ms | 武汉 722 ms | 北京 665 ms | 均 200 |

各城市不同，数据仅说明抽样可用和延迟，不能当作严格对照或全网保证。首次冷请求另一次抽样为约 0.6–2.2 秒。响应含正确图片 MIME、`Access-Control-Allow-Origin: *` 与目标 commit。证据：[主域名三运营商](https://api.globalping.io/v1/measurements/2BUQMrqcBFIanQbMr00021N7v)、[备用域名三运营商](https://api.globalping.io/v1/measurements/2bZDrXKEWX5Z8Sjxs00021N7v)。`jsd.onmicrosoft.cn` 对项目文件跳转到 `raw.githubusercontent.com`，已排除，[检测](https://api.globalping.io/v1/measurements/2iZ3Qk8gRezLkVodP00021N7u)。

[服务文档](https://jsdmirror.com/docs)说明免费流量/请求限制及文件大小限制（单文件 20 MB、包 150 MB），当前素材均在限制内。免费服务的 [SLA.md](https://github.com/jsdmirror/JSDMirror/blob/main/SLA.md) 明确不保证可用率，因此保留独立备用与本站兜底。大陆速度应持续抽样，不能承诺所有用户或时间段都同样快。

## 验证

`pnpm run test:per-file-cdn` 使用真实临时 Git 仓库验证逐文件历史及 URL 稳定性；`node scripts/test-css-per-file-cdn.mjs` 验证真实浏览器嵌套 CSS/字体/图片与逐文件故障候选（需 Playwright）。`pnpm run test:static-cdn` 验证服务器 HTML、固定提交、嵌套 CSS、同源接口及 Worker 装载器；设置 `ROKA_PLAYWRIGHT_MODULE` 后还验证真实页面加载与 API/静态域分离。`pnpm run test:cdn-runtime` 使用真实浏览器和多个测试 HTTP origin 检查故障切换、SRI、顺序/去重、取消与 srcset。`pnpm run test:intro` 包含 glTF 依赖重写与释放测试。浏览器工具需另行提供 Playwright/Chromium，不增加线上依赖。

CSS 解析器覆盖仓库现有的带引号 @import 和 url() 语法，保留 import 后的媒体条件；不面向任意第三方 CSS 语法。循环 @import 应在源码中消除。新增原生 ES 模块相对导入前，应像介绍片一样打包，或通过运行时显式逐文件加载，避免浏览器继承父模块 SHA。Git 历史过浅导致无法找到文件修改提交时，该文件回本站；完整历史部署可获得全部映射。
