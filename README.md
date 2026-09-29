# 试镜采集台（Audition Capture Bench）

纯前端的试镜采集台：授权摄像头与麦克风后，对一个 take 执行**开始 / 暂停 / 继续 / 停止**，录制中可随时打**瞬间标记**（短标签，时间按排除暂停的实际录制时长），停止后形成成片与冻结标记，可回放、点标记跳转、选为交付版并下载。支持三种采集模式：**音视频（默认）/ 仅视频 / 仅音频**，仅空闲时可切换。

- **无后端、无任何在线服务**：Vite 构建为纯静态文件，nginx 只负责托管。
- **成片不持久化**：take 仅以 `Blob` + `blob:` 对象 URL 存在于当前页面内存，刷新或关闭即清空；删除 take 或卸载页面会释放轨道与对象 URL。
- **安全上下文**：浏览器只在 `https://` 或 `http://localhost`（含 `127.0.0.1`）下授予摄像头/麦克风。容器映射到本机后请用 `http://localhost:${WEB_PORT}` 访问；跨机访问请在前置反代上终止 TLS。

## 快速开始（本地开发）

```bash
npm ci
npm run dev        # http://localhost:5173
```

其它脚本：

```bash
npm test           # Vitest 跑全部单测（含媒体替身交错用例）
npm run typecheck  # 仅类型检查
npm run build      # tsc -b && vite build -> dist/
npm run verify     # 测试 + 类型检查 + 构建（一次性验收）
npm run preview    # 本地预览构建产物
```

## Docker Compose

`WEB_PORT` 是**可覆盖**的宿主机托管端口（默认 `8080`，容器内固定 80）：

```bash
docker compose up --build                 # http://localhost:8080
WEB_PORT=9000 docker compose up --build    # http://localhost:9000
```

一次性验收服务 `verify`（挂在 `verify` profile 下，普通 `up` 不会启动；跑完即退出，退出码即验收结论）：

```bash
docker compose --profile verify build verify
docker compose --profile verify run --rm verify
# 等价于容器内执行：npm run verify  -> vitest run && tsc --noEmit && vite build
```

## 采集模式与编码探测

三种模式**独立**按顺序探测，选择各组首个受支持项：

| 模式 | 探测顺序 |
| --- | --- |
| 音视频（默认） | `video/webm;codecs=vp9,opus` → `video/webm;codecs=vp8,opus` → `video/webm` |
| 仅视频 | `video/webm;codecs=vp9` → `video/webm;codecs=vp8` → `video/webm` |
| 仅音频 | `audio/webm;codecs=opus` → `audio/webm` |

- 某组候选全部不可用时**只禁用该模式**（界面标注“不可用”），不影响其它模式；选中被禁用模式开拍会报 `codec-unsupported`，**不会取设备，也不改动任何旧 take / 交付选择**。
- 只有 `idle` 可切换模式；点击“开始 take”会在**申请权限之前**冻结模式、MIME 与相关设备并进入 `starting`，直到回到 `idle` 才解锁。等待授权期间重复开始、切换模式或设备都无法让取流约束、录制参数与成片类型漂移。
- **授权弹窗未决可取消**：`starting` 期间停止入口显示为“取消”且始终可用。取消是确定结局——立即回 `idle`、不产生成片、不报错；迟到的授权结果（无论放行还是拒绝）其流会被立即释放并丢弃，随后可改模式/设备重拍。
- **时长冻结在停止/中断时刻**：成片 `durationMs` 在用户停止或设备轨道 `ended` 的一瞬间冻结，排除授权等待、全部暂停段与编码器封装等待（`stop` 事件晚到多久都不影响素材长度）；暂停中停止不会重复累计已录片段。
- 采集计划只请求所需轨道：仅音频传 `video:false`、仅视频传 `audio:false`，不相关的设备选择不进入约束；因此缺少无关设备（如仅视频时没有麦克风）不算失败。
- take 保存采集模式与**实际** MIME：仅音频成片用 `<audio>` 回放，其余用 `<video>`；下载始终指向当前所选交付 take 的对象 URL。

### 设备热插拔与枚举竞态

导演在录制现场热插拔摄像头/麦克风，页面在**初次载入、`devicechange` 设备事件与每条成片收尾（`onSettled`）**三处都会发起 `enumerateDevices()`。真实环境里枚举是异步且可能乱序返回的，本台做了三层保证：

- **清单只反映最后一次有效设备事件**：每次枚举带单调递增序号，只有“最后发起”的枚举有权应用结果。较早的枚举（初次载入、上一条成片收尾触发的那次）若在较新的设备变更**之后**才返回，其旧清单被整体丢弃——不会覆盖下拉框，刚接入的设备不会消失。
- **空闲时的明确选择在设备仍可用时保持**：自动落默认只发生在“此前无明确选择”（初次枚举 / 该类设备曾全部消失）时；一旦导演手动选定，后续枚举只要该设备仍在清单中就保持选择，绝不退回列表首个设备。
- **所选设备确实消失时给出明确提示**：选择的设备被拔除后，待选自动落到同类首个可用设备（无设备则退回系统默认，约束退化为 `true`），并在对应下拉旁明确提示“所选 X（原设备名）已断开；下一条 take 将改用 Y”，设备重新接回或导演重新手动选择后提示清除。
- **本次录制展示与实际采集严格一致**：开拍瞬间（申请权限之前）随采集计划一起冻结设备 id **与展示名**。授权等待（`starting`）/ 录制 / 暂停 / 收尾期间设备被拔除、替换或迟到枚举返回，下拉与“本次实际采集”行都恒显冻结设备（设备已离清单时补一个“（本次已锁定）”选项），取流约束也始终是冻结的 id；非空闲时切换入口禁用且不会被任何枚举静默改写。
- **当前条与下一条互不污染**：录制期间的设备变更只更新“下一条 take”的待选设备与提示，不动本次冻结身份；停止后再开拍沿用已对账的待选设备，不会请求已拔除的旧设备。若冻结设备已被物理拔除，浏览器的 `getUserMedia` 会以 `start-failed` 明确报错，不产生成片、不改动旧 take 与交付选择。
- 每条成片固化**实际采集设备身份**（`take.videoDevice` / `take.audioDevice`，与模式无关的轨道为 `null`，空 id 表示系统默认），成片卡片据此展示“摄像头/麦克风：名称”；旧成片、瞬间标记、交付选择与三种录制模式完全兼容。

### 瞬间标记（moments）

导演在录制中给“值得回看的瞬间”打短标签，回放时按**实际录制时长**定位跳转，暂停与设备中断都不会让标记漂移：

- **写入窗口**：`addMarker(label)` 只在 `recording` 且尚未冻结停止时接受。`starting`（等待权限）/ `paused` / `stopping`（停止中）/ `idle`（含已结束）一律拒绝，并返回 `{ok:false, reason, message}` 的明确提示（UI 同步禁用输入并展示原因）；标签先 trim，空串与超过 `MARKER_LABEL_MAX_LENGTH`（50）同样拒绝，不产生标记。
- **有效时钟**：标记时间戳与成片时长共用同一套排除暂停的时钟（`currentElapsed`：各录制段累计，暂停/授权等待/封装等待均不计入），暂停多久标记都不漂移。
- **同毫秒次序**：同一毫秒可连续写入多条，会话内自增 `order` 区分创建次序；冻结后的 `take.markers` 按 `(timeMs, order)` 升序，绝不重排。
- **随成片冻结与裁剪**：停止成功后标记与该 take 的 Blob、`durationMs` 一同冻结；停止超时（兜底收尾）或设备中断时，标记按停止冻结的有效时长裁剪（`timeMs <= durationMs`，纯函数 `freezeTakeMarkers`，返回不可变排序副本），跳转点永不越过成片时长。
- **空 Blob 无带标记 take**：全程零数据（`empty-take`/`stop-failed`）时不产生成片，标记随失败会话一起丢弃。
- **会话隔离**：标记挂在会话对象上，旧 take 的 recorder 迟到事件/调用受 session 守卫挡下，**绝不可能把标记附到新 take**；切换 take 各带各的冻结标记，删除 take 随之一并释放。
- 回放卡片中每条标记是一个按钮，点击把对应 `<video>/<audio>` 的 `currentTime` 定位到 `timeMs/1000` 并播放（再按 `durationMs` 夹一次），实现标记与播放器时间同步。

## 生命周期与交错处理（核心约束）

录制内核见 `src/recorder/CaptureRecorder.ts`，状态机为：

```
idle → starting → recording ⇄ paused → stopping → idle
```

- **重复操作幂等**：非 `idle` 的 `start` 一律忽略（无参 `start` 兼容为音视频）；`pause/resume/stop` 都做状态守卫，重复点击不产生副作用。
- **开拍冻结**：`start` 在申请权限前先冻结模式/MIME/设备并进入 `starting`；授权、取流或 recorder 构造/启动失败时释放刚拿到的新流并回到 `idle`，各模式能力、旧成片与交付选择原样保留。
- **start 失败**：所选模式编码全不支持时根本不取设备；授权拒绝报 `permission-denied`；取流成功但 recorder 构造/启动失败会释放刚拿到的轨道。失败均回到 `idle`，**不破坏已有成片**。
- **chunk 合并**：录制以 250ms timeslice 持续产出；只有非空 chunk 被按到达顺序缓存，空 chunk 丢弃。
- **收到 `stop` 才形成成片**：`dataavailable` 再多也不提前成片；最终 `new Blob(chunks, {type: mimeType})` 生成唯一一个可播放 webm。
- **设备中断只停一次**：任一轨道 `ended` 或 recorder `error` 触发一次停止并把成片原因标为 `device-interrupted`；重复 ended/error 被挡下。有数据则保留成片，零数据则以 `empty-take` 失败。
- **拔掉摄像头 / 尾段晚到**：轨道 ended 与 `dataavailable`/`stop` 交错时，`stop` 事件之前到达的尾段照常并入；`stop()` 对已 `inactive` 的 recorder 抛 `InvalidStateError` 时，内核吞掉异常并用微任务兜底落定，给晚到尾段留窗口；`stop` 之后到达的陈旧事件一律丢弃。因此「最终轨道中断且尾段晚到」只会得到**一个**成片。
- **停止必有结局（不会久留 stopping）**：调用 `stop()` 后统一武装 1000ms（`STOP_FINALIZE_GRACE_MS`）兜底定时器。recorder `stop()` 在 recording/paused 态直接抛错（拒绝停止）、正常返回但始终不发 `stop` 事件、或设备中断后编码器沉默，都会在窗口结束时**强制收尾**：摘掉监听、`stop()` 全部轨道、回 `idle`。窗口内已有非空数据则保留为唯一成片（时长仍冻结在停止/中断时刻），零数据以 `stop-failed`/`empty-take` 失败，**不产生空壳半成品**。真实 `stop` 先到时定时器被清除，二者竞争只落定一次。
- **take 会话隔离**：每条 take 持有自增 session，旧 recorder 的迟到事件通过 session 守卫丢弃，**旧事件不能改变新 take**。
- **资源释放**：每次停止/中断/取消都 `stop()` 全部轨道（取消发生在授权未决时则释放迟到授权返回的流）并摘掉事件监听；删除 take 撤销其对象 URL；组件卸载（页面关闭）执行 `dispose()` 停轨并撤销所有 URL。
- **下载一致性**：下载直接使用所选 take 的对象 URL（指向 `take.blob` 本身），下载内容与所选交付版逐字节一致。

## 测试

Vitest + jsdom + Testing Library。`src/test/fakes.ts` 提供可精确编排事件顺序的媒体替身（`emitData` / `emitEmptyData` / `emitStop` / `emitError` / 轨道 `emitEnded`、可模拟 `stop()` 对 inactive 或任意状态抛错、按约束产轨、`missingKinds` 缺设备、`controllableGetUserMedia` 可控权限 Promise 等）；`src/test/virtualClock.ts` 提供同时驱动 `now()` 与兜底定时器的虚拟时钟（`advance`/`pendingCount`）。覆盖：

- 三种模式各自的编码探测顺序、回退与模式隔离（某组全不可用只禁用该模式）；
- **纯 `audio/webm` 环境**、视频编码不可用时的模式隔离；
- 仅音频 `video:false` / 仅视频 `audio:false` 的取流约束与 take 模式、实际 MIME；
- **授权等待期间（starting）冻结**：重复开始、切模式/设备不改变取流约束、录制参数与成片类型，回 idle 才解锁；
- **授权未决时取消**（可控权限 Promise）：立即回 idle、无成片无错误，迟到 grant/deny 的流被释放，旧 take 与交付选择保留，可立即改模式重拍（内核 + hook + UI 三层）；
- 麦克风物理不可用时仅视频仍能成片、回放与下载；
- chunk 顺序合并、空 chunk 丢弃、收到 stop 才成片；
- 暂停/继续时长；**暂停中停止**只计已录段、不重复累计、暂停与封装等待均排除；
- 重复 start/pause/resume/stop；
- 授权拒绝、recorder 构造/启动失败的资源释放与旧成片/交付选择保留；
- 轨道 ended、recorder error 的单次停止与原因标注；无数据中断失败；
- **尾段在 stop 前后交错**、stop 后陈旧事件丢弃、旧 take 事件不污染新 take；
- 设备中断 + inactive `InvalidStateError` 的微任务兜底（仍只产出一个成片）；
- **延迟结束 / 停止抛错 / 无结束事件**（虚拟时钟 + 伪 MediaRecorder）：封装等待不计入时长，兜底窗口后强制回 idle、释放全部轨道，有数据保留唯一一个成片、零数据报 `stop-failed`，且可立即再录；
- 真实 stop 与兜底定时器竞争只落定一次；starting 中 dispose 后迟到授权流被释放；
- **瞬间标记**（虚拟时钟 + 可控 MediaRecorder）：录制中写入与有效时钟、暂停边界不漂移；同毫秒按 `order` 保序；paused/starting/stopping/idle 及空/超长标签的明确拒绝；停止成功后随 Blob/时长冻结，停止超时与设备中断按冻结时长裁剪，空 Blob 不生成带标记 take；`stop`/`dataavailable` 乱序下标记与成片一致；旧 take 迟到事件不把标记附到新 take、连续多 take 与中断后重录不串标记；
- **页面测试核对标记与播放器时间同步**：录制中实时标记列表、暂停提示，停止后点击标记把 `video.currentTime` 定位到精确的有效时间（含同毫秒两条、中断 take 与重录 take 各自播放器不串扰）；
- 删除/卸载释放对象 URL 与轨道；
- hook 层：仅空闲可切换设备与模式、授权失败不毁旧成片、新拍失败保留已选交付版；
- **设备枚举/热插拔交错**（可控枚举乱序返回 + 可控插拔/取流等待，穿插手动选择、授权等待、暂停与成片收尾）：迟到旧清单被序号守卫丢弃不覆盖下拉；空闲明确选择在设备可用时保持、消失时自动落可用设备并明确提示下一条所用设备；`starting`/录制/暂停期间冻结设备 id 与展示名不被改写、取流约束精确落在冻结设备；成片卡片固化实际设备身份（三模式各自的相关轨道）；所选设备拔除后开拍的 `start-failed` 提示与旧成片/交付/标记兼容。

## 目录结构

```
src/
  recorder/CaptureRecorder.ts     # 无 React 依赖的录制状态机内核
  hooks/useAuditionRecorder.ts    # 设备枚举、take/URL 内存管理、预览复用单流
  App.tsx / styles.css            # 采集台界面
  test/                           # 媒体替身、虚拟时钟、harness、setup
```
