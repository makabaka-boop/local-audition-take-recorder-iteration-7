/**
 * 媒体替身：精确模拟真实 MediaRecorder 在设备拔除时的事件交错。
 *
 * 可编排的关键时序：
 * - emitData(chunk)           —— dataavailable（晚到的尾段也用它）
 * - emitStop()                —— stop 事件（成片只在此刻形成）
 * - emitError()               —— recorder error
 * - endTrack(kind)            —— 轨道 ended（设备拔除）
 * - stop() 的行为可用 stopThrowsOnInactive 控制
 *
 * 取流替身有两种：
 * - fakeGetUserMediaFactory：按约束（video/audio:false 或缺设备）立即落定
 * - controllableGetUserMedia：授权 Promise 由测试手动 resolve/reject，
 *   用于验证“等待授权期间模式/MIME/设备已冻结”
 */

import type {
  CaptureMode,
  MediaRecorderLike,
  MediaStreamLike,
  MediaStreamTrackLike,
} from '../recorder/CaptureRecorder'

export class FakeTrack implements MediaStreamTrackLike {
  readyState: 'live' | 'ended' = 'live'
  private listeners = new Set<() => void>()

  constructor(
    readonly kind: string,
    private readonly onStopCall?: () => void,
  ) {}

  stop(): void {
    if (this.readyState === 'ended') return
    this.readyState = 'ended'
    this.onStopCall?.()
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === 'ended') this.listeners.add(listener)
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === 'ended') this.listeners.delete(listener)
  }

  /** 模拟设备拔除：readyState 转 ended 并派发 ended */
  emitEnded(): void {
    this.readyState = 'ended'
    for (const listener of [...this.listeners]) listener()
  }
}

/** 全部三种模式的默认 MIME 候选（浏览器替身默认全支持） */
export const ALL_SUPPORTED_MIMES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'audio/webm;codecs=opus',
  'audio/webm',
]

export interface FakeRecorderOptions {
  supported?: string[]
  mimeType?: string
  /** stop() 在 inactive 时抛 InvalidStateError（Chrome 拔除设备行为） */
  stopThrowsOnInactive?: boolean
  startThrows?: Error
  ctorThrows?: Error
}

export class FakeMediaRecorder implements MediaRecorderLike {
  static supported: string[] = [...ALL_SUPPORTED_MIMES]
  static ctorThrows: Error | null = null
  static startThrows: Error | null = null
  static stopThrowsOnInactive = false
  /** stop() 无论何种状态都抛错（模拟录制器拒绝停止） */
  static stopThrows: Error | null = null
  static instances: FakeMediaRecorder[] = []

  static isTypeSupported(mimeType: string): boolean {
    return FakeMediaRecorder.supported.includes(mimeType)
  }

  /** 测试后复位全局静态配置 */
  static reset(): void {
    FakeMediaRecorder.supported = [...ALL_SUPPORTED_MIMES]
    FakeMediaRecorder.ctorThrows = null
    FakeMediaRecorder.startThrows = null
    FakeMediaRecorder.stopThrowsOnInactive = false
    FakeMediaRecorder.stopThrows = null
    FakeMediaRecorder.instances = []
  }

  readonly mimeType: string
  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror:
    | ((event: { error?: { name?: string; message?: string } }) => void)
    | null = null

  timeslice: number | undefined
  startCalls = 0
  stopCalls = 0

  constructor(
    _stream: MediaStreamLike,
    options?: { mimeType?: string },
  ) {
    if (FakeMediaRecorder.ctorThrows) throw FakeMediaRecorder.ctorThrows
    this.mimeType = options?.mimeType ?? 'video/webm;codecs=vp9,opus'
    FakeMediaRecorder.instances.push(this)
  }

  start(timeslice?: number): void {
    if (FakeMediaRecorder.startThrows) throw FakeMediaRecorder.startThrows
    this.startCalls++
    this.timeslice = timeslice
    this.state = 'recording'
  }

  stop(): void {
    this.stopCalls++
    if (FakeMediaRecorder.stopThrows) throw FakeMediaRecorder.stopThrows
    if (
      this.state === 'inactive' &&
      FakeMediaRecorder.stopThrowsOnInactive
    ) {
      throw new DOMException(
        "Failed to execute 'stop': The MediaRecorder state is inactive",
        'InvalidStateError',
      )
    }
    this.state = 'inactive'
    // 注意：真实浏览器由 UA 异步派发 stop，测试用 emitStop 精确控制时机
  }

  pause(): void {
    if (this.state === 'recording') this.state = 'paused'
  }

  resume(): void {
    if (this.state === 'paused') this.state = 'recording'
  }

  emitData(parts: Array<BlobPart | string | number>): void {
    // 每个 chunk 以换行结尾，合并后可直接验证到达顺序
    const blob = new Blob([parts.join('|'), '\n'], {
      type: this.mimeType,
    })
    this.ondataavailable?.({ data: blob })
  }

  emitEmptyData(): void {
    this.ondataavailable?.({ data: new Blob([], { type: this.mimeType }) })
  }

  emitStop(): void {
    this.state = 'inactive'
    this.onstop?.()
  }

  emitError(error: { name?: string; message?: string }): void {
    this.onerror?.({ error })
  }
}

export interface CreatedSession {
  stream: MediaStreamLike
  tracks: FakeTrack[]
  /** 本次取流收到的约束 */
  constraints: MediaStreamConstraints
}

export interface FakeGetUserMediaOptions {
  /** 立即以该错误拒绝（如授权被拒） */
  reject?: Error
  /**
   * 设备缺口：列出的 kind 视为物理不存在，请求时以 NotFoundError 拒绝。
   * 采集计划只请求所需轨道，因此“缺少无关设备”永远不会触发拒绝。
   */
  missingKinds?: Array<'audio' | 'video'>
  /** 记录每次调用（与 sessions 平行；拒绝时也会留痕） */
  calls?: MediaStreamConstraints[]
}

/** 按约束决定要产出的轨道种类（video:false / audio:false 不取对应轨道） */
function tracksForConstraints(
  constraints: MediaStreamConstraints | undefined,
  missingKinds: ReadonlySet<string>,
): FakeTrack[] {
  const tracks: FakeTrack[] = []
  if (constraints?.video !== false) {
    if (missingKinds.has('video')) {
      throw new DOMException('Requested device not found', 'NotFoundError')
    }
    tracks.push(new FakeTrack('video'))
  }
  if (constraints?.audio !== false) {
    if (missingKinds.has('audio')) {
      throw new DOMException('Requested device not found', 'NotFoundError')
    }
    tracks.push(new FakeTrack('audio'))
  }
  return tracks
}

/** getUserMedia 替身工厂；每次 resolve 一套可操控的会话 */
export function fakeGetUserMediaFactory(opts?: FakeGetUserMediaOptions): {
  getUserMedia: (
    constraints?: MediaStreamConstraints,
  ) => Promise<MediaStreamLike>
  sessions: CreatedSession[]
} {
  const sessions: CreatedSession[] = []
  const missing = new Set(opts?.missingKinds ?? [])
  const getUserMedia = async (
    constraints?: MediaStreamConstraints,
  ): Promise<MediaStreamLike> => {
    const c = constraints ?? {}
    opts?.calls?.push(c)
    if (opts?.reject) throw opts.reject
    // 缺少被请求的设备：与真实浏览器一致地 reject（缺少无关设备不算）
    const tracks = tracksForConstraints(c, missing)
    const stream: MediaStreamLike = {
      getTracks: () => tracks,
    }
    sessions.push({ stream, tracks, constraints: c })
    return stream
  }
  return { getUserMedia, sessions }
}

/** 一次等待测试手动放行的授权请求 */
export interface PendingPermission {
  constraints: MediaStreamConstraints
  resolve: (stream: MediaStreamLike) => void
  reject: (err: unknown) => void
}

export interface ControllableMedia {
  /** 等待中的授权请求（先进先出） */
  pending: PendingPermission[]
  /** 所有调用收到的约束 */
  calls: MediaStreamConstraints[]
  /** 已放行的会话 */
  sessions: CreatedSession[]
  /** 放行最早一次请求：按其约束产出对应轨道 */
  grant: () => void
  /** 拒绝最早一次请求 */
  deny: (err?: Error) => void
  getUserMedia: (
    constraints?: MediaStreamConstraints,
  ) => Promise<MediaStreamLike>
}
/**
 * 可控权限 Promise 的 getUserMedia：
 * 调用本身只登记 pending，授权弹窗结果由测试通过 grant()/deny() 决定，
 * 从而精确复现“点击开拍后正在等待授权”的时间窗。
 */
export function controllableGetUserMedia(): ControllableMedia {
  const pending: PendingPermission[] = []
  const calls: MediaStreamConstraints[] = []
  const sessions: CreatedSession[] = []

  const getUserMedia = (
    constraints?: MediaStreamConstraints,
  ): Promise<MediaStreamLike> => {
    const c = constraints ?? {}
    calls.push(c)
    return new Promise<MediaStreamLike>((resolve, reject) => {
      pending.push({ constraints: c, resolve, reject })
    })
  }

  const grant = () => {
    const item = pending.shift()
    if (!item) throw new Error('没有等待中的授权请求')
    const tracks: FakeTrack[] = []
    if (item.constraints.video !== false) tracks.push(new FakeTrack('video'))
    if (item.constraints.audio !== false) tracks.push(new FakeTrack('audio'))
    const stream: MediaStreamLike = { getTracks: () => tracks }
    sessions.push({ stream, tracks, constraints: item.constraints })
    item.resolve(stream)
  }

  const deny = (err?: Error) => {
    pending.shift()?.reject(err ?? new DOMException('denied', 'NotAllowedError'))
  }

  return { pending, calls, sessions, grant, deny, getUserMedia }
}

/** 由模式与设备 id 组装“只请求所需轨道”的约束（供断言/复用） */
export function expectedConstraints(
  mode: CaptureMode,
  videoDeviceId?: string,
  audioDeviceId?: string,
): MediaStreamConstraints {
  return {
    video:
      mode === 'audio-only'
        ? false
        : videoDeviceId
          ? { deviceId: { exact: videoDeviceId } }
          : true,
    audio:
      mode === 'video-only'
        ? false
        : audioDeviceId
          ? { deviceId: { exact: audioDeviceId } }
          : true,
  }
}
