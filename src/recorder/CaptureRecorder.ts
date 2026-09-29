/**
 * CaptureRecorder —— 纯前端试镜采集内核
 *
 * 设计要点：
 * 1. take 状态机：
 *    idle → starting（预检取流）→ preview（预检确认）→ starting（录制器启动）
 *    → recording ⇄ paused → stopping → idle
 *    所有外部操作都做幂等保护，重复调用不会产生副作用。
 * 2. 三种采集模式（av 音视频 / video-only 仅视频 / audio-only 仅音频），
 *    各自按顺序探测一组 MIME；某组全不可用只禁用该模式，不影响其它模式。
 * 3. 开拍瞬间（申请权限之前）冻结模式、MIME 与设备选择（设备 id 与展示名
 *    一起冻结）：starting 期间外部的重复 start / 模式切换 / 设备热插拔与
 *    迟到枚举都无法改变取流约束、录制参数、成片类型与本次展示的设备名称，
 *    直到回到 idle 才解锁。
 * 4. 采集计划只请求所需轨道：仅音频 video:false、仅视频 audio:false，
 *    缺少无关设备不算失败。
 * 5. MediaRecorder 的 stop() / dataavailable 事件顺序在真实设备上会交错
 *    （拔掉摄像头尤其明显：轨道 ended、尾段晚到、stop 最后到）。
 *    本内核只在收到 stop 事件时形成成片；stop 之前到达的非空 chunk
 *    一律按到达顺序保留；stop 之后到达的陈旧事件一律丢弃。
 * 6. 每条 take 用自增 session 隔离：旧 recorder、旧轨道、旧定时器的事件
 *    不可能污染新 take。
 * 7. 设备中断（轨道 ended 或 recorder error）只触发一次停止，并标注原因；
 *    有数据则保留成片，无数据则失败报错。
 * 8. 瞬间标记（addMarker）只在 recording 且未冻结停止时接受，时间戳取自
 *    排除暂停的有效时钟 currentElapsed；停止落定时随成片一起冻结，并按
 *    冻结的有效时长裁剪（超出部分绝不保留）。标记挂在会话对象上，旧会话
 *    迟到的事件/调用不可能把标记附到新 take；空 Blob 不产生 take，标记
 *    随会话一起丢弃。
 */

export type RecorderStatus =
  | 'idle'
  | 'starting'
  | 'preview'
  | 'recording'
  | 'paused'
  | 'stopping'

/** 瞬间标记短标签的最大长度（trim 后计） */
export const MARKER_LABEL_MAX_LENGTH = 50

/**
 * 瞬间标记：录制中由导演写入、停止后随 take 冻结。
 * 同一毫秒可写入多条，order 为会话内自增创建次序，排序键为
 * (timeMs, order)——暂停与设备中断都不会让时间戳漂移。
 */
export interface TakeMarker {
  /** 短标签（写入时已 trim，非空、长度受限） */
  label: string
  /** 相对成片起点的有效时间（毫秒，扣除暂停/授权等待/封装等待） */
  timeMs: number
  /** 会话内自增序号：相同毫秒按创建次序排列 */
  order: number
}

/** addMarker 被状态/内容守卫拒绝时的原因 */
export type MarkerRejectCode =
  | 'not-recording'
  | 'starting'
  | 'preflight'
  | 'paused'
  | 'stopping'
  | 'label-blank'
  | 'label-too-long'

/** addMarker 的确定结局：成功带回冻结前的标记，失败带回明确原因与文案 */
export type AddMarkerResult =
  | { ok: true; marker: TakeMarker }
  | { ok: false; reason: MarkerRejectCode; message: string }

/** 采集模式：音视频（默认）/ 仅视频 / 仅音频 */
export type CaptureMode = 'av' | 'video-only' | 'audio-only'

/** 成片产生的停止原因 */
export type StopReason = 'user' | 'device-interrupted'

/** 向 UI 报告的错误类型 */
export type CaptureErrorCode =
  | 'codec-unsupported'
  | 'permission-denied'
  | 'start-failed'
  | 'empty-take'
  | 'stop-failed'

/**
 * 一次采集计划引用的设备身份。
 * 开拍时随计划冻结：deviceId 决定取流约束（exact），label 供界面展示。
 * id 为空字符串表示“系统默认设备”（约束退化为 true，不带 deviceId）。
 */
export interface DeviceRef {
  id: string
  label: string
}

/**
 * 停止后等待编码器 stop 事件（含晚到尾段）的宽限窗口。
 * 真实 UA 通常在下一 tick 内派发 stop；超过该窗口仍无任何落定信号
 * （recorder.stop() 抛错且未进入 inactive，或始终不发 stop 事件）时，
 * 内核强制收尾：释放全部轨道、回到 idle，绝不久留 stopping。
 */
export const STOP_FINALIZE_GRACE_MS = 1000

export class CaptureError extends Error {
  readonly code: CaptureErrorCode
  constructor(code: CaptureErrorCode, message: string) {
    super(message)
    this.name = 'CaptureError'
    this.code = code
  }
}

export interface Take {
  id: string
  /** 成片采用的采集模式（音频成片回放用 <audio>，其余用 <video>） */
  mode: CaptureMode
  /** 成片 Blob（仅内存，刷新/卸载即消失） */
  blob: Blob
  /** 实际采集时长（毫秒，扣除暂停时段，使用挂钟时间） */
  durationMs: number
  /**
   * 随成片冻结的瞬间标记，按 (timeMs, order) 升序；
   * 已按 durationMs 裁剪，跳转时与播放器有效时间一一对应。
   */
  markers: TakeMarker[]
  mimeType: string
  reason: StopReason
  createdAt: number
  /** 回放用对象 URL，由内核/上层负责 revoke */
  url: string
  /**
   * 本条成片实际采集所用的设备身份（开拍瞬间随计划冻结）。
   * 与该模式无关的轨道为 null：仅视频成片 audioDevice=null，
   * 仅音频成片 videoDevice=null；id 为空串表示当时使用系统默认设备。
   */
  videoDevice: DeviceRef | null
  audioDevice: DeviceRef | null
}

export interface RecorderDeps {
  /** 便于测试：默认使用全局 MediaRecorder */
  MediaRecorder: MediaRecorderLikeCtor
  getUserMedia: (
    constraints: MediaStreamConstraints,
  ) => Promise<MediaStreamLike>
  createObjectURL: (blob: Blob) => string
  revokeObjectURL: (url: string) => void
  now: () => number
  randomId: () => string
  /** 定时器：真实环境用全局 setTimeout/clearTimeout，测试注入虚拟时钟 */
  setTimer: (handler: () => void, timeoutMs: number) => unknown
  clearTimer: (handle: unknown) => void
}

/** MediaRecorder 所需的最小结构面，真实 MediaRecorder 结构兼容 */
export interface MediaRecorderLikeCtor {
  isTypeSupported(mimeType: string): boolean
  new (
    stream: MediaStreamLike,
    options?: { mimeType?: string },
  ): MediaRecorderLike
}

export interface MediaRecorderLike {
  readonly mimeType: string
  readonly state: 'inactive' | 'recording' | 'paused'
  start(timeslice?: number): void
  stop(): void
  pause(): void
  resume(): void
  ondataavailable: ((event: { data: Blob }) => void) | null
  onstop: (() => void) | null
  onerror:
    | ((event: { error?: { name?: string; message?: string } }) => void)
    | null
}

export interface MediaStreamLike {
  getTracks(): MediaStreamTrackLike[]
}

export interface MediaStreamTrackLike {
  readonly kind: string
  readonly readyState: 'live' | 'ended'
  stop(): void
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

/** 全部采集模式，UI 按此顺序渲染切换项 */
export const CAPTURE_MODES: readonly CaptureMode[] = [
  'av',
  'video-only',
  'audio-only',
]

/**
 * 各模式独立、按顺序探测的 MIME 候选：
 * - 音视频：video/webm;codecs=vp9,opus → vp8,opus → 裸 video/webm
 * - 仅视频：video/webm;codecs=vp9 → vp8 → 裸 video/webm
 * - 仅音频：audio/webm;codecs=opus → 裸 audio/webm
 */
export const MODE_MIME_CANDIDATES: Record<
  CaptureMode,
  readonly string[]
> = {
  av: [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ],
  'video-only': [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ],
  'audio-only': ['audio/webm;codecs=opus', 'audio/webm'],
}

/** @deprecated 兼容旧引用：音视频模式的 MIME 候选 */
export const MIME_CANDIDATES = MODE_MIME_CANDIDATES.av

export function pickSupportedMimeType(
  ctor: MediaRecorderLikeCtor | undefined,
  candidates: readonly string[] = MODE_MIME_CANDIDATES.av,
): string | null {
  if (!ctor) return null
  for (const candidate of candidates) {
    try {
      if (ctor.isTypeSupported(candidate)) return candidate
      // 该候选不支持：继续探测下一个
    } catch {
      // 个别实现对陌生字符串抛异常，按“不支持”处理继续探测
    }
  }
  return null
}

export interface CapturePlanOptions {
  /** 采集模式，缺省 av（兼容无参开拍预检） */
  mode?: CaptureMode
  videoDeviceId?: string
  audioDeviceId?: string
  /** 所选设备在枚举清单中的展示名，随计划冻结供本次录制/成片展示 */
  videoDeviceLabel?: string
  audioDeviceLabel?: string
}

export interface RecorderCallbacks {
  onStatusChange: (status: RecorderStatus) => void
  onTake: (take: Take) => void
  onError: (error: CaptureError) => void
  /**
   * 录制中每写入一条瞬间标记即回调（已通过状态/标签守卫）。
   * 可选；停止落定后标记改由 Take.markers 提供。
   */
  onMarker?: (marker: TakeMarker) => void
  /** 停止已落定（无论成片还是失败），UI 可借此刷新设备标签等 */
  onSettled: (reason: StopReason, error?: CaptureError) => void
}

/** 开拍预检冻结的采集计划：授权等待和预览期间任何外部操作都改不动它 */
interface FrozenPlan {
  mode: CaptureMode
  mimeType: string
  videoDevice: DeviceRef | null
  audioDevice: DeviceRef | null
}

/**
 * 已获得设备授权但尚未创建录制器的预检会话。
 * 这一阶段只持有预览流和轨道中断监听；确认开拍时把同一 stream 交给
 * ActiveSession，整个会话只允许 getUserMedia 一次、每条轨道只 stop 一次。
 */
interface PreviewSession {
  session: number
  stream: MediaStreamLike
  trackListeners: Array<{ track: MediaStreamTrackLike; listener: () => void }>
}

interface ActiveSession {
  session: number
  mode: CaptureMode
  recorder: MediaRecorderLike
  stream: MediaStreamLike
  mimeType: string
  /** 本次实际采集所用设备（开拍时冻结；与模式无关的轨道为 null） */
  videoDevice: DeviceRef | null
  audioDevice: DeviceRef | null
  chunks: Blob[]
  startedAt: number
  accumulatedMs: number
  pausedAt: number | null
  /** 是否已请求停止（防重复停止 / 中断只停一次） */
  stopRequested: boolean
  /** stop 事件是否已到达，到达后一切陈旧数据丢弃 */
  finalized: boolean
  /**
   * 时长冻结点（请求停止 / 设备中断的时刻）。
   * 一旦冻结，最终时长即此值：暂停、授权等待与封装等待均不计入。
   */
  frozenDurationMs: number | null
  /**
   * 本会话已写入的瞬间标记（按创建次序追加；同一毫秒以 order 区分）。
   * 只有 recording 态可写入；停止落定时随成片冻结并按 frozenDurationMs 裁剪。
   */
  markers: TakeMarker[]
  /** 会话内标记自增序号 */
  markerSeq: number
  /** 编码器迟迟不落定时强制收尾的兜底定时器句柄 */
  stopTimer: unknown
  /** 兜底是否由定时器强制触发（用于区分失败文案） */
  forcedByTimer: boolean
  stopReason: StopReason
  /** 停止原因附带的设备信息，用于无成片时的报错文案 */
  interruptionMessage: string
  trackListeners: Array<{ track: MediaStreamTrackLike; listener: () => void }>
}

const MODE_DEVICE_TEXT: Record<CaptureMode, string> = {
  av: '摄像头或麦克风',
  'video-only': '摄像头',
  'audio-only': '麦克风',
}

/** 各状态/内容守卫拒绝写入瞬间标记时给用户的明确提示 */
const MARKER_REJECT_MESSAGE: Record<MarkerRejectCode, string> = {
  paused: '已暂停，不能打标记；继续录制后再标记。',
  starting: '正在请求设备或启动录制器，尚未开始录制，不能打标记。',
  preflight: '仍在开拍预检，确认开拍后才能打标记。',
  stopping: '正在收尾停止，标记已冻结，不能再写入。',
  'not-recording': '当前没有正在录制的 take，不能打标记。',
  'label-blank': '标记内容不能为空，请输入短标签。',
  'label-too-long': `标记最多 ${MARKER_LABEL_MAX_LENGTH} 个字，请缩短后再试。`,
}

const MARKERS_EMPTY: readonly TakeMarker[] = Object.freeze([])

function codecUnsupportedMessage(mode: CaptureMode): string {
  if (mode === 'audio-only') {
    return '当前浏览器不支持任何 audio/webm 录制编码（opus），仅音频模式无法开拍。'
  }
  if (mode === 'video-only') {
    return '当前浏览器不支持任何 video/webm 视频编码（vp9/vp8），仅视频模式无法开拍。'
  }
  return '当前浏览器不支持任何 webm 录制编码（vp9/vp8），无法开拍。'
}

export class CaptureRecorder {
  private status: RecorderStatus = 'idle'
  private sessionCounter = 0
  /** 开拍预检/录制会话持有的流：同一代次确认开拍时只转交所有权 */
  private preview: PreviewSession | null = null
  private active: ActiveSession | null = null
  /** 资源释放记账：即使 Promise/轨道事件交错，也保证每条轨道只 stop 一次 */
  private releasedTracks = new WeakSet<MediaStreamTrackLike>()
  /** 开拍时冻结、回到 idle 时清除的采集计划 */
  private plan: FrozenPlan | null = null
  private disposed = false

  constructor(
    private readonly callbacks: RecorderCallbacks,
    private readonly deps: RecorderDeps,
  ) {}

  getStatus(): RecorderStatus {
    return this.status
  }

  /** 某模式开机前探测：该模式候选均不可用时返回 null（UI 据此禁用该模式） */
  getSupportedMimeType(mode: CaptureMode = 'av'): string | null {
    return pickSupportedMimeType(
      this.deps.MediaRecorder,
      MODE_MIME_CANDIDATES[mode],
    )
  }

  /** 三种模式各自的能力探测结果，互不影响 */
  getSupportedMimeTypes(): Record<CaptureMode, string | null> {
    return {
      av: this.getSupportedMimeType('av'),
      'video-only': this.getSupportedMimeType('video-only'),
      'audio-only': this.getSupportedMimeType('audio-only'),
    }
  }

  /** 当前进行中（含预检/录制）实际冻结的模式；idle 时为 null */
  getActiveMode(): CaptureMode | null {
    return this.active?.mode ?? this.plan?.mode ?? null
  }

  /** 当前进行中（含预检/录制）冻结的实际 MIME；idle 时为 null */
  getActiveMimeType(): string | null {
    return this.active?.mimeType ?? this.plan?.mimeType ?? null
  }

  /**
   * 当前会话的流：预检成功后立即可供 UI 实时预览；确认开拍后不换流，
   * 只是所有权转交给录制会话。idle / 授权等待时为 null。
   */
  getActiveStream(): MediaStreamLike | null {
    return this.active?.stream ?? this.preview?.stream ?? null
  }

  /**
   * 当前进行中（含 starting/recording/paused/stopping）本次实际使用的设备。
   * 与模式无关的轨道为 null；idle 时为 null。设备一旦在开拍时冻结，
   * 之后的热插拔/迟到枚举都改不动它。
   */
  getActiveVideoDevice(): DeviceRef | null {
    return this.active?.videoDevice ?? this.plan?.videoDevice ?? null
  }

  getActiveAudioDevice(): DeviceRef | null {
    return this.active?.audioDevice ?? this.plan?.audioDevice ?? null
  }

  /**
   * 进入开拍预检：在申请权限前冻结模式、MIME 与相关设备身份，然后只申请
   * 一次 MediaStream。成功后停留在 preview 供界面显示实时预览/输入反馈；
   * 此时还没有 MediaRecorder，故绝不可能产生可交付 take。
   */
  beginPreflight(options: CapturePlanOptions = {}): void {
    if (this.disposed) return
    // 只有 idle 能开启新预检；starting/preview/录制中重复调用一律忽略。
    if (this.status !== 'idle') return

    // 模式与 MIME 在申请权限之前冻结：本模式无可用编码时根本不取设备，
    // 也不触碰任何旧 take；只禁用该模式，其它模式能力原样保留。
    const mode = options.mode ?? 'av'
    const mimeType = this.getSupportedMimeType(mode)
    if (!mimeType) {
      this.emitError(
        new CaptureError('codec-unsupported', codecUnsupportedMessage(mode)),
      )
      return
    }

    const plan = this.buildPlan(options, mode, mimeType)
    const session = ++this.sessionCounter
    this.plan = plan
    // 先进入 starting 完成冻结，随后才申请权限
    this.setStatus('starting')

    this.deps
      .getUserMedia(this.buildConstraints(plan, mode))
      .then((stream) => this.attachPreviewStream(session, stream))
      .catch((err: unknown) => {
        // 用户取消预检、发起新一代预检或卸载后，迟到的拒绝只按代次丢弃；
        // 此时没有本次流可释放，也不能覆盖新会话的错误。
        if (this.disposed || session !== this.sessionCounter || !this.plan) return
        this.preview = null
        this.setStatus('idle')
        const name = errorName(err)
        const denied = name === 'NotAllowedError' || name === 'SecurityError'
        const device = MODE_DEVICE_TEXT[mode]
        const text = denied
          ? `${device}授权被拒绝，无法开拍。可在浏览器地址栏重新授权后再试。`
          : `无法开启${device}：${messageOf(err)}`
        this.emitError(
          new CaptureError(denied ? 'permission-denied' : 'start-failed', text),
        )
      })
  }

  /**
   * 确认预检画面和输入反馈无误后正式开拍：复用预检会话的同一个
   * MediaStream 构造并启动 MediaRecorder，不再调用 getUserMedia。
   * 成功后流的所有权从预检会话转交给录制会话；失败则由本方法释放这一次
   * 持有的流，且不触碰历史 take。
   */
  confirmStart(): void {
    if (this.disposed || this.status !== 'preview') return
    const preview = this.preview
    const plan = this.plan
    if (!preview || !plan) return

    const { session, stream } = preview
    // 先摘除预检中断监听；下面会为录制会话重新挂载。这里不能 stop 轨道。
    this.removeTrackListeners(preview.trackListeners)
    preview.trackListeners = []

    // 仍以 preview 状态完成同步构造：构造失败直接回 idle，避免界面进入
    // “启动中”却没有可归属的有效会话/流。
    let recorder: MediaRecorderLike
    try {
      recorder = new this.deps.MediaRecorder(stream, {
        mimeType: plan.mimeType,
      })
    } catch (err) {
      this.preview = null
      this.releaseStreamOnce(stream)
      this.setStatus('idle')
      this.emitError(
        new CaptureError('start-failed', `录制器初始化失败：${messageOf(err)}`),
      )
      return
    }

    const now = this.deps.now()
    const next: ActiveSession = {
      session,
      mode: plan.mode,
      recorder,
      stream,
      mimeType: recorder.mimeType || plan.mimeType,
      videoDevice: plan.videoDevice,
      audioDevice: plan.audioDevice,
      chunks: [],
      startedAt: now,
      accumulatedMs: 0,
      pausedAt: null,
      stopRequested: false,
      finalized: false,
      frozenDurationMs: null,
      markers: [],
      markerSeq: 0,
      stopTimer: null,
      forcedByTimer: false,
      stopReason: 'user',
      interruptionMessage: '',
      trackListeners: [],
    }
    this.active = next
    // 会话对象已接管 stream 后才离开 preview；starting 回调也能读到同一流。
    this.preview = null
    this.setStatus('starting')

    recorder.ondataavailable = (event) => {
      // 会话守卫：旧 take 的事件永不影响新 take
      if (this.disposed || this.active?.session !== session) return
      this.handleData(next, event.data)
    }
    recorder.onstop = () => {
      if (this.disposed || this.active?.session !== session) return
      this.handleStop(next)
    }
    recorder.onerror = (event) => {
      if (this.disposed || this.active?.session !== session) return
      this.handleError(next, event.error)
    }

    for (const track of stream.getTracks()) {
      // ended 是一次性事件，闭包捕获本会话
      const listener = () => {
        if (this.disposed || this.active?.session !== session) return
        if (next.finalized || next.stopRequested) return
        this.requestStop(next, 'device-interrupted')
      }
      track.addEventListener('ended', listener)
      next.trackListeners.push({ track, listener })
    }

    try {
      // timeslice 让 chunk 在录制中持续到达，尾段晚到也能并入
      recorder.start(250)
    } catch (err) {
      this.teardownSession(next)
      this.active = null
      this.setStatus('idle')
      this.emitError(
        new CaptureError('start-failed', `录制启动失败：${messageOf(err)}`),
      )
      return
    }

    this.setStatus('recording')
  }

  /** 按当前选择构造计划；设备 id 与展示名一起冻结。 */
  private buildPlan(
    options: CapturePlanOptions,
    mode: CaptureMode,
    mimeType: string,
  ): FrozenPlan {
    // 只冻结本模式实际会用到的设备：不相关的设备选择一律不进入计划。
    const videoDevice: DeviceRef | null =
      mode === 'audio-only'
        ? null
        : {
            id: (options.videoDeviceId ?? '') || '',
            label: options.videoDeviceLabel ?? '',
          }
    const audioDevice: DeviceRef | null =
      mode === 'video-only'
        ? null
        : {
            id: (options.audioDeviceId ?? '') || '',
            label: options.audioDeviceLabel ?? '',
          }
    return { mode, mimeType, videoDevice, audioDevice }
  }

  /** 采集计划只请求所需轨道：缺少无关设备不会形成约束。 */
  private buildConstraints(
    plan: FrozenPlan,
    mode: CaptureMode,
  ): MediaStreamConstraints {
    const videoId = plan.videoDevice?.id ?? ''
    const audioId = plan.audioDevice?.id ?? ''
    return {
      video:
        mode === 'audio-only'
          ? false
          : videoId
            ? { deviceId: { exact: videoId } }
            : true,
      audio:
        mode === 'video-only'
          ? false
          : audioId
            ? { deviceId: { exact: audioId } }
            : true,
    }
  }

  /** 预检取流返回后的装配路径：只挂轨道中断监听，不创建录制器。 */
  private attachPreviewStream(
    session: number,
    stream: MediaStreamLike,
  ): void {
    // 授权返回期间用户可能已取消、改模式/设备发起新一代预检或卸载；
    // 迟到的 stream 必须立即释放且只由当前裁决获胜的代次释放。
    if (this.disposed || session !== this.sessionCounter || !this.plan) {
      this.releaseStreamOnce(stream)
      return
    }

    const tracks = stream.getTracks()
    if (tracks.some((track) => track.readyState === 'ended')) {
      this.releaseStreamOnce(stream)
      this.setStatus('idle')
      this.emitError(
        new CaptureError('start-failed', '设备在预检开始前已结束，请重新检查设备。'),
      )
      return
    }

    const preview: PreviewSession = { session, stream, trackListeners: [] }
    for (const track of tracks) {
      const listener = () => {
        if (this.disposed || this.preview?.session !== session) return
        // 预检阶段轨道提前结束：本次预检确定失败，释放同一份流，不产生 take。
        this.teardownPreview(preview)
        this.preview = null
        this.setStatus('idle')
        this.emitError(
          new CaptureError(
            'start-failed',
            `${track.kind === 'video' ? '摄像头' : '麦克风'}在开拍前断开，请重新预检。`,
          ),
        )
      }
      track.addEventListener('ended', listener)
      preview.trackListeners.push({ track, listener })
    }

    this.preview = preview
    this.setStatus('preview')
  }

  pause(): void {
    const a = this.active
    if (!a || this.status !== 'recording') return
    try {
      a.recorder.pause()
    } catch {
      return
    }
    const now = this.deps.now()
    a.accumulatedMs += now - a.startedAt
    a.pausedAt = now
    this.setStatus('paused')
  }

  resume(): void {
    const a = this.active
    if (!a || this.status !== 'paused' || a.pausedAt === null) return
    try {
      a.recorder.resume()
    } catch {
      return
    }
    // 从继续时刻重新计时；否则停止结算时会把暂停时段再算一遍
    a.startedAt = this.deps.now()
    a.pausedAt = null
    this.setStatus('recording')
  }

  /**
   * 写入一条瞬间标记。
   *
   * 仅当正在录制（recording）且尚未冻结停止时接受：
   * - starting（等待权限）/ paused / stopping / idle（含已结束）一律拒绝，
   *   并给出与状态对应的明确文案；
   * - 标签先 trim，空串或超长同样拒绝，不产生任何标记；
   * - 时间戳取 currentElapsed —— 与成片时长同一套“排除暂停”的有效时钟，
   *   暂停多久都不会让标记漂移；
   * - 同毫秒多次写入各自独立，order 为会话内自增创建次序；
   * - 标记挂在当前会话上：旧会话迟到的调用/事件不可能写入新 take。
   */
  addMarker(label: string): AddMarkerResult {
    if (this.disposed) {
      return this.rejectMarker('not-recording')
    }
    if (this.status !== 'recording') {
      const reason: MarkerRejectCode =
        this.status === 'paused'
          ? 'paused'
          : this.status === 'preview'
            ? 'preflight'
            : this.status === 'starting'
              ? 'starting'
              : this.status === 'stopping'
                ? 'stopping'
                : 'not-recording'
      return this.rejectMarker(reason)
    }
    const a = this.active
    // recording 态理论上必有活动会话；防御式兜底，绝不把标记写到错误的 take
    if (!a) return this.rejectMarker('not-recording')

    const text = label.trim()
    if (!text) return this.rejectMarker('label-blank')
    if (text.length > MARKER_LABEL_MAX_LENGTH) {
      return this.rejectMarker('label-too-long')
    }

    const marker: TakeMarker = {
      label: text,
      timeMs: this.currentElapsed(a),
      order: a.markerSeq++,
    }
    a.markers.push(marker)
    this.callbacks.onMarker?.(marker)
    return { ok: true, marker }
  }

  /** 当前活动会话已写入的标记（停止冻结前的实时镜像，按创建次序）；无会话为 [] */
  getLiveMarkers(): readonly TakeMarker[] {
    return this.active ? [...this.active.markers] : MARKERS_EMPTY
  }

  /**
   * 用户停止；重复调用安全，停止中的再次调用无效。
   * starting（授权弹窗未决）/ preview（预检画面确认前）时语义均为“取消”：
   * 不产生任何成片。starting 还没有流，只作废旧代次；preview 立即释放本次
   * 预检流一次。迟到的授权结果由会话代次裁决，绝不能进入新会话。
   */
  stop(): void {
    if (this.disposed) return
    // 授权未决：取消本次预检。设备尚被浏览器弹窗占用、流尚未返回，
    // 这里没有轨道可释放；让 session 立即作废即可解锁模式/设备切换。
    if (this.status === 'starting') {
      this.cancelStarting()
      return
    }
    // 已拿到预览流但尚未确认开拍：明确取消旧预检并释放本次轨道。
    if (this.status === 'preview') {
      this.cancelPreview()
      return
    }
    const a = this.active
    if (!a) return
    this.requestStop(a, 'user')
  }

  /** 卸载：释放预检/录制轨道，不产生 take（成片本就只在内存） */
  dispose(): void {
    this.disposed = true
    // 授权未决时卸载：作废 session，迟到的授权结果只会释放其流
    if (this.preview) {
      this.teardownPreview(this.preview)
      this.preview = null
    }
    this.plan = null
    const a = this.active
    if (a) this.teardownSession(a)
    this.active = null
    if (this.status !== 'idle') this.setStatus('idle')
  }

  // ---- 内部 ----

  /** 取消等待授权的预检：确定结局是“取消”——无成片、无错误、回 idle */
  private cancelStarting(): void {
    // 作废自增 session：迟到的 grant/deny 与迟到的流全部失效
    this.sessionCounter++
    this.preview = null
    this.plan = null
    this.setStatus('idle')
  }

  /** 取消已显示预览的预检：释放本次持有的同一份流，无成片、无错误。 */
  private cancelPreview(): void {
    const preview = this.preview
    if (!preview) return
    // 先推进代次，防止正在派发的轨道事件/极端重入再次裁决同一资源。
    this.sessionCounter++
    this.teardownPreview(preview)
    this.preview = null
    this.plan = null
    this.setStatus('idle')
  }

  private requestStop(a: ActiveSession, reason: StopReason): void {
    if (a.finalized || a.stopRequested) return
    a.stopRequested = true
    a.stopReason = reason

    // 时长在此刻冻结：排除此后的全部时间——
    // - 编码器封装等待（stop 事件晚到）不计入；
    // - 暂停中停止时暂停时段不计入（currentElapsed 在 paused 时不增长）。
    a.frozenDurationMs = this.currentElapsed(a)

    if (this.status === 'recording' || this.status === 'paused') {
      this.setStatus('stopping')
    }

    // 先把编码器缓冲吐出，再停。轨道 ended 时 state 可能已不是 recording，
    // stop() 对 inactive 会抛 InvalidStateError——吞掉，并让事件循环排空
    // 一轮再兜底落定，给“晚到的尾段 chunk”留出并入窗口；
    // 若 onstop 在这之前到达，finalized 会使兜底自动失效。
    let inactiveAfterThrow = false
    try {
      a.recorder.stop()
    } catch {
      inactiveAfterThrow = a.recorder.state === 'inactive'
      if (inactiveAfterThrow) {
        queueMicrotask(() => {
          if (!this.disposed && this.active === a && !a.finalized) {
            this.handleStop(a)
          }
        })
      }
      // stop() 在 recording/paused 态直接抛错（拒绝停止）时也不能悬挂：
      // 交由统一的兜底定时器强制收尾。
    }

    // 统一兜底：recorder 拒绝停止、stop() 后始终不发 stop 事件、
    // 或设备中断后编码器沉默，都在宽限窗口后强制落定，保证轨道必释放。
    this.armStopWatchdog(a)
  }

  /**
   * 停止落定兜底：宽限窗口内未收到 stop 事件就强制收尾。
   * 窗口给晚到尾段（stop 之前的 dataavailable）保留并入机会；
   * 窗口之后到达的 chunk 因 finalized 一律丢弃。
   */
  private armStopWatchdog(a: ActiveSession): void {
    if (a.stopTimer !== null) return
    a.stopTimer = this.deps.setTimer(() => {
      if (this.disposed || this.active !== a || a.finalized) return
      a.forcedByTimer = true
      this.handleStop(a)
    }, STOP_FINALIZE_GRACE_MS)
  }

  /** 当前未结算录制段的时长；暂停态自暂停时刻起不再增长 */
  private currentElapsed(a: ActiveSession): number {
    if (a.pausedAt !== null) return a.accumulatedMs
    return a.accumulatedMs + (this.deps.now() - a.startedAt)
  }

  private rejectMarker(reason: MarkerRejectCode): AddMarkerResult {
    return { ok: false, reason, message: MARKER_REJECT_MESSAGE[reason] }
  }

  /**
   * 停止落定时冻结标记：按停止冻结的有效时长裁剪——
   * 用户停止超时（兜底收尾）或设备中断时，有效时长冻结在请求停止/中断
   * 时刻，晚于该时刻的标记理论上不可能写入（停止后已被状态守卫挡下），
   * 这里仍做一次防御式裁剪，保证回放跳转点永不超出成片有效时长。
   * 冻结副本按 (timeMs, order) 升序：同毫秒严格保持创建次序。
   */
  private freezeMarkers(a: ActiveSession, durationMs: number): TakeMarker[] {
    return freezeTakeMarkers(a.markers, durationMs)
  }

  private handleData(a: ActiveSession, data: Blob): void {
    // stop 到达之后的陈旧 chunk 一律不并入
    if (a.finalized) return
    // 只缓存非空 chunk：零字节 chunk（含 size 为 0 的 Blob）丢弃，
    // 否则全程仅空数据也会拼出一个“可回放/可下载”的空壳成片
    if (data && data.size > 0) a.chunks.push(data)
  }

  private handleError(
    a: ActiveSession,
    raw: { name?: string; message?: string } | undefined,
  ): void {
    if (a.finalized) return
    // 设备中断路径：只触发一次停止并标注原因（重复 error 被挡下）
    a.interruptionMessage = raw?.message || raw?.name || '设备中断'
    this.requestStop(a, 'device-interrupted')
  }

  private handleStop(a: ActiveSession): void {
    if (a.finalized) return
    a.finalized = true

    // 时长冻结在请求停止/中断的时刻，handleStop 无论何时被调用
    // （stop 事件晚到或兜底定时器）都不再读取时钟，封装等待不计入。
    const durationMs = a.frozenDurationMs ?? this.currentElapsed(a)
    // 标记与时长同一冻结点：按有效时长裁剪后随成片冻结
    const markers = this.freezeMarkers(a, durationMs)
    const reason = a.stopReason
    const mode = a.mode
    const mimeType = a.mimeType
    const chunks = a.chunks
    const interruptedMessage = a.interruptionMessage
    const forced = a.forcedByTimer
    const videoDevice = a.videoDevice
    const audioDevice = a.audioDevice

    this.teardownSession(a)
    this.active = null
    this.setStatus('idle')

    if (chunks.length === 0) {
      const error = forced
        ? new CaptureError(
            'stop-failed',
            '录制器停止后迟迟未完成封装（未收到结束事件），且本次没有可保留的数据，本次拍摄失败。',
          )
        : reason === 'device-interrupted'
          ? new CaptureError(
              'empty-take',
              `设备在产出任何数据之前中断（${interruptedMessage || '轨道 ended'}），本次拍摄失败。`,
            )
          : new CaptureError(
              'empty-take',
              '未采集到任何数据，本次拍摄失败。',
            )
      this.callbacks.onSettled(reason, error)
      this.emitError(error)
      return
    }

    const blob = new Blob(chunks, { type: mimeType })
    const take: Take = {
      id: this.deps.randomId(),
      mode,
      blob,
      durationMs,
      markers,
      mimeType,
      reason,
      createdAt: this.deps.now(),
      url: this.deps.createObjectURL(blob),
      videoDevice,
      audioDevice,
    }
    this.callbacks.onTake(take)
    this.callbacks.onSettled(reason)
  }

  private removeTrackListeners(
    trackListeners: Array<{ track: MediaStreamTrackLike; listener: () => void }>,
  ): void {
    for (const { track, listener } of trackListeners) {
      track.removeEventListener('ended', listener)
    }
    trackListeners.length = 0
  }

  /**
   * 释放一份流的全部轨道。WeakSet 是跨预检/录制代次的释放记账：
   * 同一份流从预检转交给录制器时不会提前 stop；取消、启动失败、卸载、
   * 迟到授权与轨道 ended 交错时，最终每条轨道也只会 stop 一次。
   */
  private releaseStreamOnce(stream: MediaStreamLike): void {
    for (const track of stream.getTracks()) {
      if (this.releasedTracks.has(track)) continue
      this.releasedTracks.add(track)
      track.stop()
    }
  }

  /** 拆除预检监听并释放流；确认开拍时不能调用它（只摘除监听、保留流）。 */
  private teardownPreview(preview: PreviewSession): void {
    this.removeTrackListeners(preview.trackListeners)
    this.releaseStreamOnce(preview.stream)
  }

  private teardownSession(a: ActiveSession): void {
    if (a.stopTimer !== null) {
      this.deps.clearTimer(a.stopTimer)
      a.stopTimer = null
    }
    a.recorder.ondataavailable = null
    a.recorder.onstop = null
    a.recorder.onerror = null
    this.removeTrackListeners(a.trackListeners)
    this.releaseStreamOnce(a.stream)
  }

  private setStatus(status: RecorderStatus): void {
    this.status = status
    // 回到 idle 即解锁：冻结的采集计划到此结束
    if (status === 'idle') this.plan = null
    this.callbacks.onStatusChange(status)
  }

  private emitError(error: CaptureError): void {
    this.callbacks.onError(error)
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * 停止落定时冻结瞬间标记的纯函数：
 * - 按停止冻结的有效时长裁剪（timeMs <= durationMs 才保留），
 *   保证回放跳转点永不越过成片有效时长；
 * - 返回浅拷贝数组，按 (timeMs, order) 升序排列，
 *   同一毫秒严格按创建次序；不修改入参。
 */
export function freezeTakeMarkers(
  markers: readonly TakeMarker[],
  durationMs: number,
): TakeMarker[] {
  return markers
    .filter((m) => m.timeMs <= durationMs)
    .map((m) => ({ ...m }))
    .sort((a, b) => a.timeMs - b.timeMs || a.order - b.order)
}

/** DOMException 在部分环境（jsdom）不继承 Error，需防御式读取 name */
function errorName(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err) {
    const name = (err as { name?: unknown }).name
    if (typeof name === 'string') return name
  }
  if (err instanceof Error) return err.name
  return ''
}
