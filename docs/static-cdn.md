# 固定提交的静态资源 CDN

## 路径与版本

生产路径为 `https://cdn.jsdmirror.com/gh/oimasterkafuu/Roka@<40 位 SHA>/static/<文件>`。服务启动时通过 `git log -1 --format=%H -- static` 选择最近修改静态树的提交；普通合并沿用素材提交，若合并解决冲突并产生新的静态树，则使用该合并提交。每个页面、播放器及其内嵌 glTF 缓冲/贴图、CSS 字体链均沿用同一 SHA。更新 `static/` 必须先构建、提交并推送素材提交，再合并部署。只更新后端时沿用原有静态提交。

默认候选依次为 `cdn.jsdmirror.com`、`cdn.jsdmirror.cn`、`testingcf.jsdelivr.net`、本站。前两个属于同一运营方，第三个为独立提供方。只在请求失败、非成功 HTTP 状态或脚本/入口 CSS 完整性校验失败后切换。入口脚本通过 preload 并行下载，再按依赖顺序执行，不用超时重插方式冒险重复执行；素材 fetch 等待响应头每个源最多 8 秒，使用者取消时立即停止且不切换。模型依赖先经 CDN 下载为可释放的 blob URL，共享贴图只取一次。

HTML 仍由本站动态生成，以保留认证与会话凭据；`/api/`、`/socket.io/`、导航路径不改写。浏览器要求 Service Worker 注册入口同源，因此 `/sw.js?v=<站点版本>` 仅返回小型装载器，通过 `importScripts` 获取固定版本的 CDN 实现。最后回退 `/sw.js?source=1` 为原实现，避免递归。没有上传或下载整段 MP4，介绍片由用户同意后按需加载静态素材并在客户端实时绘制。

脚本与入口 CSS 的 SHA-384 由部署的本地文件计算，浏览器校验后执行/应用；嵌套 CSS、字体、图片与模型使用固定提交地址和 HTTPS。不要用 CDN 地址包裹登录页、API 或用户凭据。

## 配置与开发

| 变量                      | 行为                                                            |
| ------------------------- | --------------------------------------------------------------- |
| `ROKA_STATIC_CDN=0`       | 显式禁用，离线开发使用本站静态文件                              |
| `ROKA_STATIC_CDN=1`       | 启用（默认）；生产应使用已提交的资源版本                        |
| `ROKA_STATIC_COMMIT`      | 覆盖为完整 40 位十六进制 SHA；用于没有 Git 历史的归档部署或回滚 |
| `ROKA_STATIC_CDN_ORIGINS` | 逗号分隔的裸 HTTPS origin；测试允许 localhost/127.0.0.1 的 HTTP |

开发模式 `pnpm run dev` 显式设置 `ROKA_STATIC_CDN=0`，本地编辑直接生效。其他启动方式只要有有效提交即默认启用 CDN；不根据工作树是否变化自动关闭，因为生产构建可能重写 gzip/Brotli 副本，或存在未跟踪的服务器文件。缺少 Git 历史且未指定 SHA 时使用本站。CDN 故障时最后可使用本站文件，生产源码与指定素材 SHA 必须一致。

发布流程：构建并校验 → 推送功能提交 → 预热该 SHA 的入口 JS/CSS、manifest、模型与音乐 → 合并并推送 main → 检查线上 HTML 中的 SHA 与 `/api/version`。不要固定一个过期 SHA，也不要改为浮动分支名。仓库需可公开读取；私有仓库应改用自管 CDN，不将访问令牌放入前端。

## 中国大陆检测与限制

2026-10-24 对项目真实文件使用完整 SHA，从 Globalping 中国大陆探针抽样：

| CDN    | 电信        | 联通        | 移动        | HTTP   |
| ------ | ----------- | ----------- | ----------- | ------ |
| `.com` | 南京 334 ms | 南宁 190 ms | 上海 359 ms | 均 200 |
| `.cn`  | 桂林 413 ms | 武汉 722 ms | 北京 665 ms | 均 200 |

各城市不同，数据仅说明抽样可用和延迟，不能当作严格对照或全网保证。首次冷请求另一次抽样为约 0.6–2.2 秒。响应含正确图片 MIME、`Access-Control-Allow-Origin: *` 与目标 commit。证据：[主域名三运营商](https://api.globalping.io/v1/measurements/2BUQMrqcBFIanQbMr00021N7v)、[备用域名三运营商](https://api.globalping.io/v1/measurements/2bZDrXKEWX5Z8Sjxs00021N7v)。`jsd.onmicrosoft.cn` 对项目文件跳转到 `raw.githubusercontent.com`，已排除，[检测](https://api.globalping.io/v1/measurements/2iZ3Qk8gRezLkVodP00021N7u)。

[服务文档](https://jsdmirror.com/docs)说明免费流量/请求限制及文件大小限制（单文件 20 MB、包 150 MB），当前素材均在限制内。免费服务的 [SLA.md](https://github.com/jsdmirror/JSDMirror/blob/main/SLA.md) 明确不保证可用率，因此保留独立备用与本站兜底。大陆速度应持续抽样，不能承诺所有用户或时间段都同样快。

## 验证

`pnpm run test:static-cdn` 验证服务器 HTML、固定提交、嵌套 CSS、同源接口及 Worker 装载器；设置 `ROKA_PLAYWRIGHT_MODULE` 后还验证真实页面加载与 API/静态域分离。`pnpm run test:cdn-runtime` 使用真实浏览器和多个测试 HTTP origin 检查故障切换、SRI、顺序/去重、取消与 srcset。`pnpm run test:intro` 包含 glTF 依赖重写与释放测试。浏览器工具需另行提供 Playwright/Chromium，不增加线上依赖。
