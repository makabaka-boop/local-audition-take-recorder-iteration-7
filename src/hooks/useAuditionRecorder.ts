import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CAPTURE_MODES,
  CaptureError,
  CaptureRecorder,
  type AddMarkerResult,
  type CaptureMode,
  type DeviceRef,
  type RecorderDeps,
  type RecorderStatus,
  type Take,
  type TakeMarker,
} from '../recorder/CaptureRecorder'

export interface MediaDeviceInfoLite {
  deviceId: string
  kind: 'videoinput' | 'audioinput'
  label: string
}

type DeviceKind = 'videoinput' | 'audioinput'

function createBrowserDeps(): RecorderDeps {
  const g = globalThis as unknown as {
    MediaRecorder: RecorderDeps['MediaRecorder']
  }
  return {
    MediaRecorder: g.MediaRecorder,
    getUserMedia: (constraints) =>
      navigator.mediaDevices.getUserMedia(constraints),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    now: () => Date.now(),
    randomId: () =>
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `take-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    setTimer: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
}

function detectCapabilities(
  recorder: CaptureRecorder,
): Record<CaptureMode, string | null> {
  return recorder.getSupportedMimeTypes()
}

/** 设备类型对应的中文称谓，用于提示文案 */
const KIND_NOUN: Record<DeviceKind, string> = {
  videoinput: '摄像头',
  audioinput: '麦克风',
}

export function useAuditionRecorder() {
  const [status, setStatus] = useState<RecorderStatus>('idle')
  const [devices, setDevices] = useState<MediaDeviceInfoLite[]>([])
  const [videoDeviceId, setVideoDeviceId] = useState('')
  const [audioDeviceId, setAudioDeviceId] = useState('')
  const [takes, setTakes] = useState<Take[]>([])
  const [selectedTakeId, setSelectedTakeId] = useState<string | null>(null)
  const [error, setError] = useState<CaptureError | null>(null)
  const [liveStream, setLiveStream] = useState<MediaStream | null>(null)
  // 音视频为默认模式；只有空闲可切换
  const [mode, setModeState] = useState<CaptureMode>('av')
  const [mimeByMode, setMimeByMode] = useState<
    Record<CaptureMode, string | null>
  >({ av: null, 'video-only': null, 'audio-only': null })
  // 进行中的实际模式/MIME（starting 起冻结，回 idle 清空）
  const [activeMode, setActiveMode] = useState<CaptureMode | null>(null)
  const [activeMimeType, setActiveMimeType] = useState<string | null>(null)
  /**
   * 本次录制（含 starting）实际使用的设备身份：开拍瞬间随采集计划冻结，
   * 授权等待/录制/暂停/收尾期间的热插拔与迟到枚举都改不动它；回 idle 为 null。
   */
  const [activeVideoDevice, setActiveVideoDevice] = useState<DeviceRef | null>(
    null,
  )
  const [activeAudioDevice, setActiveAudioDevice] = useState<DeviceRef | null>(
    null,
  )
  /**
   * 所选设备在最新清单中消失时的明确提示（下一条 take 将改用的设备）。
   * 空闲手动选择或设备重新出现后清除；录制期间设备拔除时它描述“下一条”
   * 将使用的设备，与本次冻结的实际设备互不干扰。
   */
  const [videoNotice, setVideoNotice] = useState('')
  const [audioNotice, setAudioNotice] = useState('')
  /**
   * 当前录制会话实时累积的瞬间标记（仅 recording 中可写入）。
   * 进入新会话（starting）或落定回 idle 时清空：停止成功后标记改由
   * 所选/列表 Take.markers 提供，切换 take 自然各带各的标记。
   */
  const [liveMarkers, setLiveMarkers] = useState<TakeMarker[]>([])

  const recorderRef = useRef<CaptureRecorder | null>(null)
  // take 列表镜像：卸载时批量 revoke，避免依赖 state 闭包过期
  const takesRef = useRef<Take[]>([])
  // 设备清单/选择镜像：枚举返回是异步的，应用结果时必须读到发起时的基线
  // 而不是 setState 回调里可能已被更新的 state（配合枚举序号防迟到覆盖）。
  const devicesRef = useRef<MediaDeviceInfoLite[]>([])
  const videoIdRef = useRef('')
  const audioIdRef = useRef('')
  // 当前待选设备的展示名镜像：设备被拔除后新清单里查不到旧 label，
  // 提示文案仍须能准确说出断开的是哪台设备。
  const videoLabelRef = useRef('')
  const audioLabelRef = useRef('')
  /** 枚举序号：单调递增，只有最后一次发起的枚举有权应用结果 */
  const enumSeqRef = useRef(0)
  const mountedRef = useRef(true)

  /**
   * 把一份（可能迟到的）设备清单与选择做对账。
   * - 清单恒为参数给出的“最新清单”；
   * - 空闲时的明确选择在设备仍可用时保持不变；
   * - 所选设备消失时自动落到同类首个可用设备（无设备则退回系统默认 ''），
   *   并产生明确提示，告诉导演下一条 take 将使用哪台设备；
   * - 从无明确选择（初次枚举/尚无该类设备）落到默认时不提示，
   *   设备重新出现使选择保持时清除旧提示。
   *
   * 无论录制是否进行都可以调用：它只改“下一条 take 的待选设备”，
   * 本次实际设备由 activeXxxDevice 冻结展示，二者互不污染。
   */
  const reconcileDevices = useCallback(
    (mapped: MediaDeviceInfoLite[]) => {
      const reconcileKind = (
        kind: DeviceKind,
        prevId: string,
        prevLabel: string,
      ): { id: string; notice: string } => {
        const ofKind = mapped.filter((d) => d.kind === kind)
        const labelOf = (id: string) =>
          mapped.find((d) => d.deviceId === id)?.label ?? id
        const fallback = ofKind[0]?.deviceId ?? ''
        const fallbackLabel = ofKind[0]?.label ?? '系统默认设备'

        if (prevId) {
          if (ofKind.some((d) => d.deviceId === prevId)) {
            // 明确选择仍可用：保持不动；设备重新出现时旧提示作废
            return { id: prevId, notice: '' }
          }
          // 明确选择确实消失：用选择时记录的名称描述断开的设备，
          // 明确提示下一条 take 将使用哪台设备
          const noun = KIND_NOUN[kind]
          const disconnectedName =
            prevLabel || labelOf(prevId) || `${KIND_NOUN[kind]} ${prevId.slice(0, 4)}`
          const notice =
            fallback === ''
              ? `所选${noun}（${disconnectedName}）已断开，当前没有可用的${noun}；下一条 take 将请求系统默认${noun}。`
              : `所选${noun}（${disconnectedName}）已断开；下一条 take 将改用${fallbackLabel}。`
          return { id: fallback, notice }
        }
        // 此前无明确选择（初始枚举 / 该类设备曾全部消失）：静默落默认
        return { id: fallback, notice: '' }
      }

      const video = reconcileKind(
        'videoinput',
        videoIdRef.current,
        videoLabelRef.current,
      )
      const audio = reconcileKind(
        'audioinput',
        audioIdRef.current,
        audioLabelRef.current,
      )
      devicesRef.current = mapped
      videoIdRef.current = video.id
      audioIdRef.current = audio.id
      // 同步新选择的展示名（供下一次断开时命名）；空 id 时回退到通用称谓
      videoLabelRef.current =
        mapped.find((d) => d.kind === 'videoinput' && d.deviceId === video.id)
          ?.label ?? ''
      audioLabelRef.current =
        mapped.find((d) => d.kind === 'audioinput' && d.deviceId === audio.id)
          ?.label ?? ''
      setDevices(mapped)
      setVideoDeviceId(video.id)
      setAudioDeviceId(audio.id)
      // 提示随对账结果重算：仍断开则刷新为新的替代设备名称，
      // 设备重新出现/替代设备已稳定可用（下一条 take 之后的再枚举）时清除。
      setVideoNotice(video.notice)
      setAudioNotice(audio.notice)
    },
    [],
  )

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    // 只允许最后一次发起的枚举落盘：较早的枚举若在较新的设备变更之后
    // 才返回，其旧清单必须被丢弃，不能覆盖下拉框或把选择退回旧设备。
    const seq = ++enumSeqRef.current
    let list: MediaDeviceInfo[]
    try {
      list = await navigator.mediaDevices.enumerateDevices()
    } catch {
      // 枚举失败不致命：保留上一份有效清单，开拍时 getUserMedia
      // 会暴露真正的授权/设备错误
      return
    }
    if (!mountedRef.current || seq !== enumSeqRef.current) return
    const mapped: MediaDeviceInfoLite[] = list
      .filter(
        (d): d is MediaDeviceInfo =>
          d.kind === 'videoinput' || d.kind === 'audioinput',
      )
      .map((d) => ({
        deviceId: d.deviceId,
        kind: d.kind as 'videoinput' | 'audioinput',
        label:
          d.label ||
          (d.kind === 'videoinput'
            ? `摄像头 ${d.deviceId.slice(0, 4) || '默认'}`
            : `麦克风 ${d.deviceId.slice(0, 4) || '默认'}`),
      }))
    reconcileDevices(mapped)
  }, [reconcileDevices])

  useEffect(() => {
    mountedRef.current = true
    const recorder = new CaptureRecorder(
      {
        onStatusChange: (next) => {
          setStatus(next)
          // 冻结中的模式/MIME/流随状态同步：starting 即冻结，idle 即解锁
          setActiveMode(recorder.getActiveMode())
          setActiveMimeType(recorder.getActiveMimeType())
          setActiveVideoDevice(recorder.getActiveVideoDevice())
          setActiveAudioDevice(recorder.getActiveAudioDevice())
          setLiveStream((recorder.getActiveStream() as MediaStream | null) ?? null)
          // 标记按会话存活：新会话开拍或落定回 idle 都必须清空实时镜像，
          // 旧会话迟到的 onMarker 不可能残留到新 take 的界面上。
          if (next === 'starting' || next === 'idle') setLiveMarkers([])
        },
        onTake: (take) => {
          takesRef.current = [...takesRef.current, take]
          setTakes(takesRef.current)
          // 首次成片自动选为交付版；之后不抢夺用户选择
          setSelectedTakeId((prev) => prev ?? take.id)
        },
        onMarker: (marker) => {
          // 内核按会话守卫，回调一次即一条新标记；追加次序即创建次序
          // （同毫秒以 order 稳定区分），回放冻结时不重排。
          setLiveMarkers((prev) => [...prev, marker])
        },
        onError: (err) => setError(err),
        onSettled: () => {
          // 授权过一次后 label 才完整，停止后刷新设备清单
          void refreshDevices()
        },
      },
      createBrowserDeps(),
    )
    recorderRef.current = recorder
    setMimeByMode(detectCapabilities(recorder))

    void refreshDevices()
    const onDeviceChange = () => void refreshDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange)

    return () => {
      mountedRef.current = false
      navigator.mediaDevices?.removeEventListener?.(
        'devicechange',
        onDeviceChange,
      )
      // 卸载：停掉录制（释放摄像头/麦克风轨道），并撤销所有成片 URL
      recorder.dispose()
      for (const take of takesRef.current) URL.revokeObjectURL(take.url)
      takesRef.current = []
      recorderRef.current = null
      setLiveStream(null)
    }
  }, [refreshDevices])

  const start = useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder || recorder.getStatus() !== 'idle') return
    setError(null)
    // 绝不在开拍前清空既有成片：授权被拒 / 录制器初始化或启动失败时，
    // 已有的 take 及其交付版选择必须原样保留（新成片由 onTake 追加）。
    //
    // 取流统一由内核负责：进入 start 的同一拍即切到 starting 并冻结
    // 模式、MIME 与相关设备（含展示名），随后才申请权限；等待授权期间
    // 重复 start 被内核的状态守卫挡下，模式/设备切换与迟到枚举也改不动
    // 已冻结的计划。
    recorder.start({
      mode,
      videoDeviceId: videoIdRef.current,
      audioDeviceId: audioIdRef.current,
      videoDeviceLabel: videoLabelRef.current,
      audioDeviceLabel: audioLabelRef.current,
    })
  }, [mode])

  const pause = useCallback(() => recorderRef.current?.pause(), [])
  const resume = useCallback(() => recorderRef.current?.resume(), [])
  const stop = useCallback(() => recorderRef.current?.stop(), [])

  /**
   * 写入瞬间标记：只有正在录制且未冻结停止时成功。
   * 返回明确结局供 UI 即时提示（暂停/等待权限/停止中/已结束/空标签…），
   * 时间戳由内核用排除暂停的有效时钟打。
   */
  const addMarker = useCallback(
    (label: string): AddMarkerResult => {
      const recorder = recorderRef.current
      if (!recorder) {
        return {
          ok: false,
          reason: 'not-recording',
          message: '当前没有正在录制的 take，不能打标记。',
        }
      }
      return recorder.addMarker(label)
    },
    [],
  )

  const selectTake = useCallback((id: string) => setSelectedTakeId(id), [])

  const deleteTake = useCallback((id: string) => {
    const target = takesRef.current.find((t) => t.id === id)
    if (target) URL.revokeObjectURL(target.url)
    const next = takesRef.current.filter((t) => t.id !== id)
    takesRef.current = next
    setTakes(next)
    setSelectedTakeId((prev) =>
      prev === id ? (next[0]?.id ?? null) : prev,
    )
  }, [])

  const isIdle = status === 'idle'
  const canSwitchDevice = isIdle
  // 当前所选模式有可用 MIME 才允许开拍；冻结期间（starting…）按钮同样禁用
  const canStart = isIdle && mimeByMode[mode] !== null
  // 瞬间标记只在录制中可写入：暂停/等待权限/停止中/已结束一律禁用入口
  const canMark = status === 'recording'
  const selectedTake = takes.find((t) => t.id === selectedTakeId) ?? null

  return {
    status,
    devices,
    videoDeviceId,
    audioDeviceId,
    // 仅空闲可切换设备：录制/授权等待中调用直接忽略（读内核状态，
    // 同一拍内的重复点击也无法穿透）。手动的明确选择立即生效并清除
    // “设备已断开”的旧提示——这是导演的新决定。
    setVideoDeviceId: (id: string) => {
      if (recorderRef.current?.getStatus() !== 'idle') return
      videoIdRef.current = id
      videoLabelRef.current =
        devicesRef.current.find(
          (d) => d.kind === 'videoinput' && d.deviceId === id,
        )?.label ?? ''
      setVideoDeviceId(id)
      setVideoNotice('')
    },
    setAudioDeviceId: (id: string) => {
      if (recorderRef.current?.getStatus() !== 'idle') return
      audioIdRef.current = id
      audioLabelRef.current =
        devicesRef.current.find(
          (d) => d.kind === 'audioinput' && d.deviceId === id,
        )?.label ?? ''
      setAudioDeviceId(id)
      setAudioNotice('')
    },
    /** 本次录制实际冻结使用的设备（idle 为 null） */
    activeVideoDevice,
    activeAudioDevice,
    /** 所选设备消失时关于“下一条 take”的明确提示 */
    videoNotice,
    audioNotice,
    mode,
    modes: CAPTURE_MODES,
    /** 各模式独立的实际 MIME（该模式全不可用时为 null，仅禁用该模式） */
    mimeByMode,
    /** 向后兼容：当前所选（或进行中冻结）模式的 MIME */
    supportedMimeType: activeMimeType ?? mimeByMode[mode],
    activeMode,
    activeMimeType,
    // 仅空闲可切换模式：开拍后模式即冻结，回到 idle 才解锁；
    // 目标模式自身无可用 MIME（已被禁用）时同样不得选中——既不会取设备，
    // 也不会改动任何旧 take / 交付选择。
    setMode: (next: CaptureMode) => {
      if (recorderRef.current?.getStatus() !== 'idle') return
      if (mimeByMode[next] === null) return
      setModeState(next)
    },
    takes,
    selectedTake,
    selectTake,
    deleteTake,
    error,
    canStart,
    canSwitchDevice,
    canMark,
    liveMarkers,
    liveStream,
    start,
    pause,
    resume,
    stop,
    addMarker,
  }
}
