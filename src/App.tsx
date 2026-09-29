import { useEffect, useRef, useState, type RefObject } from 'react'
import { useAuditionRecorder } from './hooks/useAuditionRecorder'
import type { MediaDeviceInfoLite } from './hooks/useAuditionRecorder'
import {
  MARKER_LABEL_MAX_LENGTH,
  type CaptureMode,
  type DeviceRef,
  type RecorderStatus,
  type Take,
  type TakeMarker,
} from './recorder/CaptureRecorder'

const STATUS_TEXT: Record<RecorderStatus, string> = {
  idle: '空闲',
  starting: '正在请求设备…',
  preview: '预检中',
  recording: '录制中',
  paused: '已暂停',
  stopping: '正在收尾…',
}

const MODE_TEXT: Record<CaptureMode, string> = {
  av: '音视频',
  'video-only': '仅视频',
  'audio-only': '仅音频',
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = String(Math.floor(total / 60)).padStart(2, '0')
  const s = String(total % 60).padStart(2, '0')
  return `${m}:${s}`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 设备身份的稳定展示名：空 id（系统默认）或空标签给统一回退 */
function deviceLabel(device: DeviceRef | null): string {
  if (!device) return '—'
  return device.label || (device.id ? `设备 ${device.id.slice(0, 4)}` : '系统默认设备')
}

/**
 * 设备下拉的选项与当前值：
 * - 空闲：值为待选设备，选项来自最新清单（外加一个缺设备时的默认项）；
 * - 非空闲：值恒为本次开拍冻结的实际设备。即便热插拔已让它离开最新清单，
 *   也补一个“（本次已锁定）”选项，使展示与实际采集设备严格一致。
 */
function deviceSelectModel(opts: {
  locked: boolean
  lockedDevice: DeviceRef | null
  list: MediaDeviceInfoLite[]
  selectedId: string
}): { value: string; options: Array<{ value: string; label: string }> } {
  if (opts.locked) {
    const dev = opts.lockedDevice
    const value = dev?.id ?? ''
    const baseLabel = dev ? deviceLabel(dev) : '系统默认设备'
    // 选项来自最新清单，但恒把冻结设备置顶并用开拍时冻结的名称展示
    // （即使清单中同 id 的标签已变化，也以冻结名为准，与实际采集一致）。
    const options = opts.list
      .filter((d) => d.deviceId !== value)
      .map((d) => ({ value: d.deviceId, label: d.label }))
    options.unshift({ value, label: `${baseLabel}（本次已锁定）` })
    return { value, options }
  }
  const options = opts.list.map((d) => ({
    value: d.deviceId,
    label: d.label,
  }))
  const known = options.some((o) => o.value === opts.selectedId)
  if (!known) {
    // 待选 id 暂不在清单（枚举往返中）：补占位，绝不让下拉空白
    options.unshift({
      value: opts.selectedId,
      label: opts.selectedId
        ? `设备 ${opts.selectedId.slice(0, 4)}（清单刷新中）`
        : '系统默认设备',
    })
  }
  return { value: opts.selectedId, options }
}

/** 标记的成片内时间：mm:ss.mmm（毫秒精度，与播放器 currentTime 对齐） */
function formatMarkerTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms))
  const m = String(Math.floor(clamped / 60000)).padStart(2, '0')
  const s = String(Math.floor((clamped % 60000) / 1000)).padStart(2, '0')
  const millis = String(clamped % 1000).padStart(3, '0')
  return `${m}:${s}.${millis}`
}

/** 非录制状态下“为什么此刻不能打标记”的明确提示（与内核拒绝文案呼应） */
const MARKER_BLOCKED_HINT: Partial<Record<RecorderStatus, string>> = {
  starting: '正在请求设备或启动录制器，正式开始录制后才可打标记。',
  preview: '仍在开拍预检；确认画面和麦克风正常后，点“确认开拍”再打标记。',
  paused: '已暂停，不能打标记；继续录制后再标记。',
  stopping: '正在收尾停止，标记已随本 take 冻结。',
  idle: '当前没有正在录制的 take，开始录制后才可打标记。',
}

async function downloadTake(take: Take) {
  // 下载内容直接来自所选 take 的 Blob URL，保证与成片逐字节一致
  const a = document.createElement('a')
  a.href = take.url
  a.download = `audition-${take.id}.webm`
  document.body.appendChild(a)
  a.click()
  a.remove()
  // URL 不在这里 revoke：它随 take 的删除/页面卸载统一释放
}

function Preview({ stream }: { stream: MediaStream | null }) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    el.srcObject = stream
    if (stream) void el.play().catch(() => undefined)
  }, [stream])

  return (
    <video
      ref={videoRef}
      className="preview"
      muted
      playsInline
      autoPlay
    />
  )
}

type AudioAnalyserWindow = Window & {
  AudioContext?: typeof AudioContext
  webkitAudioContext?: typeof AudioContext
}

/**
 * 预检时的麦克风输入反馈。只连接到 AnalyserNode（不接扬声器），避免啸叫；
 * 测试或不支持 Web Audio 的环境降级为“麦克风已接通”，不影响同流交接。
 */
function AudioMeter({ stream, active }: { stream: MediaStream | null; active: boolean }) {
  const [level, setLevel] = useState(0)
  const [supported, setSupported] = useState(true)

  useEffect(() => {
    if (!stream || !active) {
      setLevel(0)
      setSupported(true)
      return
    }
    setLevel(0)
    setSupported(true)
    const audioTracks = stream.getAudioTracks?.() ?? []
    if (audioTracks.length === 0) {
      setSupported(false)
      return
    }

    const w = window as AudioAnalyserWindow
    const Ctor = w.AudioContext ?? w.webkitAudioContext
    if (!Ctor || !('createMediaStreamSource' in AudioContext.prototype)) {
      setSupported(false)
      return
    }

    let context: AudioContext | null = null
    let analyser: AnalyserNode | null = null
    let source: MediaStreamAudioSourceNode | null = null
    let raf = 0
    let cancelled = false

    try {
      context = new Ctor()
      source = context.createMediaStreamSource(stream)
      analyser = context.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      const sample = new Uint8Array(analyser.fftSize)

      const tick = () => {
        if (cancelled || !analyser || !context) return
        analyser.getByteTimeDomainData(sample)
        let peak = 0
        for (const value of sample) {
          const amplitude = Math.abs(value - 128) / 128
          if (amplitude > peak) peak = amplitude
        }
        setLevel(peak)
        raf = requestAnimationFrame(tick)
      }
      tick()
    } catch {
      setSupported(false)
    }

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      try {
        source?.disconnect()
      } catch {
        // jsdom/部分实现没有真实音频图，忽略
      }
      if (context && context.state !== 'closed') {
        void context.close().catch(() => undefined)
      }
    }
  }, [stream, active])

  const percent = Math.min(100, Math.round(level * 100))
  return (
    <div className="audio-meter" data-audio-meter data-audio-ready="true">
      <span className="audio-meter-label">麦克风输入</span>
      {supported ? (
        <>
          <div
            className="audio-meter-track"
            role="meter"
            aria-label="麦克风输入音量"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span className="audio-meter-fill" style={{ width: `${Math.max(4, percent)}%` }} />
          </div>
          <span className="audio-meter-state">
            {level > 0.02 ? '检测到声音' : '麦克风已接通，请试音'}
          </span>
        </>
      ) : (
        <span className="audio-meter-state">麦克风已接通</span>
      )}
    </div>
  )
}

function TakeReplay({
  take,
  selected,
  onSelect,
  onDelete,
}: {
  take: Take
  selected: boolean
  onSelect: () => void
  onDelete: () => void
}) {
  const mediaRef = useRef<HTMLMediaElement>(null)

  useEffect(() => {
    const el = mediaRef.current
    if (!el) return
    // 切换选中项时重置到该 take 自己的对象 URL
    el.src = take.url
    return () => {
      el.pause()
      el.removeAttribute('src')
      el.load()
    }
  }, [take.url])

  /** 定位到标记时刻：标记时间与成片时长同一套排除暂停的有效时钟 */
  const jumpToMarker = (marker: TakeMarker) => {
    const el = mediaRef.current
    if (!el) return
    // 永不越过成片有效时长（标记已在停止时按冻结时长裁剪，这里再夹一次）
    const seconds = Math.min(marker.timeMs, take.durationMs) / 1000
    el.currentTime = seconds
    void el.play().catch(() => undefined)
  }

  return (
    <div className={`take-card${selected ? ' selected' : ''}`}>
      {take.mode === 'audio-only' ? (
        <div className="take-audio-wrap">
          <span className="audio-badge">♫ 仅音频</span>
          <audio
            ref={mediaRef as RefObject<HTMLAudioElement>}
            controls
            playsInline
            preload="metadata"
            className="take-audio"
          />
        </div>
      ) : (
        <video
          ref={mediaRef as RefObject<HTMLVideoElement>}
          controls
          playsInline
          preload="metadata"
          className="take-video"
        />
      )}
      <div className="take-meta">
        <button
          type="button"
          className="select-btn"
          onClick={onSelect}
          disabled={selected}
          aria-pressed={selected}
        >
          {selected ? '★ 交付版' : '选为交付版'}
        </button>
        <span className="take-info">
          {MODE_TEXT[take.mode]} · {formatDuration(take.durationMs)} ·{' '}
          {formatTime(take.createdAt)}
        </span>
        <span
          className="take-devices"
          data-take-video-device={take.videoDevice?.id ?? ''}
          data-take-audio-device={take.audioDevice?.id ?? ''}
        >
          {take.mode !== 'audio-only' && (
            <span className="take-device">
              摄像头：{deviceLabel(take.videoDevice)}
            </span>
          )}
          {take.mode !== 'video-only' && (
            <span className="take-device">
              麦克风：{deviceLabel(take.audioDevice)}
            </span>
          )}
        </span>
        <span className={`take-reason reason-${take.reason}`}>
          {take.reason === 'user' ? '手动停止' : '设备中断'}
        </span>
        <button
          type="button"
          className="delete-btn"
          onClick={onDelete}
          aria-label="删除该 take"
        >
          删除
        </button>
      </div>
      {take.markers.length > 0 && (
        <div className="take-markers" aria-label="瞬间标记">
          <p className="markers-title">瞬间标记（{take.markers.length}）</p>
          <ul className="marker-list">
            {take.markers.map((marker) => (
              <li key={`${marker.timeMs}-${marker.order}`}>
                <button
                  type="button"
                  className="marker-chip"
                  data-marker-time={marker.timeMs}
                  data-marker-order={marker.order}
                  onClick={() => jumpToMarker(marker)}
                  title={`跳转到 ${formatMarkerTime(marker.timeMs)}`}
                >
                  <span className="marker-time">
                    {formatMarkerTime(marker.timeMs)}
                  </span>
                  <span className="marker-label">{marker.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** 录制中写入瞬间标记的面板：只在 recording 放开输入，其余状态给明确提示 */
function MarkerPanel({
  status,
  canMark,
  liveMarkers,
  onAdd,
}: {
  status: RecorderStatus
  canMark: boolean
  liveMarkers: TakeMarker[]
  onAdd: (label: string) => { ok: boolean; message?: string }
}) {
  const [label, setLabel] = useState('')
  const [feedback, setFeedback] = useState<{
    kind: 'ok' | 'error'
    text: string
  } | null>(null)

  const submit = () => {
    const result = onAdd(label)
    if (result.ok) {
      setFeedback({ kind: 'ok', text: '已标记。' })
      setLabel('')
    } else {
      setFeedback({ kind: 'error', text: result.message ?? '不能打标记。' })
    }
  }

  return (
    <div className="marker-panel" aria-label="瞬间标记">
      <label className="marker-input-row">
        <span>瞬间标记</span>
        <input
          type="text"
          className="marker-input"
          value={label}
          maxLength={MARKER_LABEL_MAX_LENGTH}
          placeholder={
            canMark ? '给值得回看的瞬间写个短标签，回车打标' : '仅录制中可打标记'
          }
          disabled={!canMark}
          aria-label="瞬间标记标签"
          onChange={(e) => {
            setLabel(e.target.value)
            if (feedback) setFeedback(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (canMark) submit()
            }
          }}
        />
        <button
          type="button"
          className="btn btn-marker"
          onClick={submit}
          disabled={!canMark}
        >
          打标记
        </button>
      </label>
      <p
        className={`marker-hint${canMark ? '' : ' marker-hint-blocked'}`}
        aria-live="off"
      >
        {canMark
          ? '标记时间取实际录制时长（自动扣除暂停），同毫秒多次标记按先后保留。'
          : MARKER_BLOCKED_HINT[status]}
      </p>
      {feedback && (
        <p
          className={`marker-feedback marker-feedback-${feedback.kind}`}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      )}
      {liveMarkers.length > 0 && (
        <ul className="marker-list marker-list-live">
          {liveMarkers.map((marker) => (
            <li key={`${marker.timeMs}-${marker.order}`}>
              <span
                className="marker-live-chip"
                data-live-marker-time={marker.timeMs}
              >
                <span className="marker-time">
                  {formatMarkerTime(marker.timeMs)}
                </span>
                <span className="marker-label">{marker.label}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function App() {
  const {
    status,
    devices,
    videoDeviceId,
    audioDeviceId,
    setVideoDeviceId,
    setAudioDeviceId,
    activeVideoDevice,
    activeAudioDevice,
    videoNotice,
    audioNotice,
    mode,
    modes,
    mimeByMode,
    activeMode,
    activeMimeType,
    setMode,
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
    beginPreflight,
    confirmStart,
    canConfirmStart,
    canCancel,
    canStop,
    pause,
    resume,
    stop,
    addMarker,
  } = useAuditionRecorder()

  const videoDevices = devices.filter((d) => d.kind === 'videoinput')
  const audioDevices = devices.filter((d) => d.kind === 'audioinput')
  // 进行中显示冻结的模式；空闲时显示所选模式
  const displayMode = activeMode ?? mode
  const needsVideo = displayMode !== 'audio-only'
  const needsAudio = displayMode !== 'video-only'
  const displayMime = activeMimeType ?? mimeByMode[mode]

  // 非空闲时下拉恒指向本次冻结设备；空闲时指向待选设备
  const videoSelect = deviceSelectModel({
    locked: !canSwitchDevice,
    lockedDevice: activeVideoDevice,
    list: videoDevices,
    selectedId: videoDeviceId,
  })
  const audioSelect = deviceSelectModel({
    locked: !canSwitchDevice,
    lockedDevice: activeAudioDevice,
    list: audioDevices,
    selectedId: audioDeviceId,
  })

  const displayStatusText =
    status === 'starting' && liveStream ? '正在启动录制…' : STATUS_TEXT[status]

  return (
    <main className="app">
      <header className="app-header">
        <h1>试镜采集台</h1>
        <p className="subtitle">
          纯前端采集 · 无后端 · 成片仅存在于本次页面内存，刷新即清空
        </p>
      </header>

      <section className="stage" aria-label="采集区">
        <div className="preview-wrap">
          {liveStream && needsVideo ? (
            <Preview stream={liveStream} />
          ) : liveStream && needsAudio ? (
            <div className="preview audio-placeholder" data-audio-preview>
              <span className="audio-preview-icon">♫</span>
              <strong>仅音频预检</strong>
              <AudioMeter stream={liveStream} active={!!liveStream} />
            </div>
          ) : (
            <div className="preview placeholder">
              {status === 'starting'
                ? liveStream
                  ? '正在启动录制…'
                  : displayMode === 'audio-only'
                    ? '正在请求麦克风…'
                    : displayMode === 'video-only'
                      ? '正在请求摄像头…'
                      : '正在请求摄像头与麦克风…'
                : displayMode === 'audio-only'
                  ? '检查设备后将显示麦克风输入反馈'
                  : '检查设备后将显示实时画面'}
            </div>
          )}
          {liveStream && needsVideo && needsAudio && (
            <div className="preview-audio-overlay">
              <AudioMeter stream={liveStream} active={!!liveStream} />
            </div>
          )}
          <div className={`status-badge status-${status}`}>
            <span className="status-dot" />
            {displayStatusText}
          </div>
        </div>

        <div className="controls">
          <fieldset className="mode-row" aria-label="采集模式">
            <legend>采集模式</legend>
            <div className="mode-options" role="radiogroup">
              {modes.map((m) => {
                const unavailable = mimeByMode[m] === null
                const selectable = canSwitchDevice && !unavailable
                return (
                  <label
                    key={m}
                    className={`mode-option${unavailable ? ' unavailable' : ''}`}
                  >
                    <input
                      type="radio"
                      name="capture-mode"
                      value={m}
                      checked={displayMode === m}
                      disabled={!selectable}
                      onChange={() => setMode(m)}
                    />
                    <span>{MODE_TEXT[m]}</span>
                    {unavailable && (
                      <span className="mode-na">不可用</span>
                    )}
                  </label>
                )
              })}
            </div>
            {!canSwitchDevice && (
              <p className="hint">模式已随预检冻结；取消预检或停止录制后才可切换。</p>
            )}
          </fieldset>

          <div className="device-row">
            {needsVideo && (
              <div className="device-field">
                <label>
                  摄像头
                  <select
                    value={videoSelect.value}
                    onChange={(e) => setVideoDeviceId(e.target.value)}
                    disabled={!canSwitchDevice}
                    data-device-kind="videoinput"
                  >
                    {videoSelect.options.length === 0 && (
                      <option value="">默认设备</option>
                    )}
                    {videoSelect.options.map((o) => (
                      <option key={o.value || 'default'} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                {videoNotice && (
                  <p
                    className="device-notice"
                    role="status"
                    data-device-notice="videoinput"
                  >
                    {videoNotice}
                  </p>
                )}
              </div>
            )}
            {needsAudio && (
              <div className="device-field">
                <label>
                  麦克风
                  <select
                    value={audioSelect.value}
                    onChange={(e) => setAudioDeviceId(e.target.value)}
                    disabled={!canSwitchDevice}
                    data-device-kind="audioinput"
                  >
                    {audioSelect.options.length === 0 && (
                      <option value="">默认设备</option>
                    )}
                    {audioSelect.options.map((o) => (
                      <option key={o.value || 'default'} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                {audioNotice && (
                  <p
                    className="device-notice"
                    role="status"
                    data-device-notice="audioinput"
                  >
                    {audioNotice}
                  </p>
                )}
              </div>
            )}
          </div>

          {!canSwitchDevice && (
            <div className="locked-devices" data-locked-devices>
              <p className="hint">预检/录制进行中，设备已锁定；取消预检或停止后才可切换。</p>
              <p className="locked-device-line">
                本次实际采集：
                {needsVideo && (
                  <span data-locked-video={activeVideoDevice?.id ?? ''}>
                    摄像头 {deviceLabel(activeVideoDevice)}
                  </span>
                )}
                {needsAudio && (
                  <span data-locked-audio={activeAudioDevice?.id ?? ''}>
                    麦克风 {deviceLabel(activeAudioDevice)}
                  </span>
                )}
              </p>
            </div>
          )}

          <div className="mime-line">
            编码（{MODE_TEXT[displayMode]}）：
            {displayMime ? (
              <code>{displayMime}</code>
            ) : (
              <strong className="mime-bad">
                该模式无受支持的 webm 编码，已禁用
              </strong>
            )}
          </div>

          {status === 'preview' && (
            <div className="preflight-banner" role="status" data-preflight>
              预检中：请确认画面和麦克风输入正常。确认开拍将继续使用这一条流，不会重新请求设备。
            </div>
          )}

          <div className="button-row">
            <button
              type="button"
              className="btn btn-start"
              onClick={() => beginPreflight()}
              disabled={!canStart}
            >
              检查设备
            </button>
            <button
              type="button"
              className="btn btn-confirm"
              onClick={() => confirmStart()}
              disabled={!canConfirmStart}
              data-confirm-start
            >
              确认开拍
            </button>
            <button
              type="button"
              className="btn"
              onClick={pause}
              disabled={status !== 'recording'}
            >
              暂停
            </button>
            <button
              type="button"
              className="btn"
              onClick={resume}
              disabled={status !== 'paused'}
            >
              继续
            </button>
            <button
              type="button"
              className="btn btn-stop"
              onClick={stop}
              disabled={!canStop}
              aria-label={canCancel ? '取消预检' : '停止'}
            >
              {canCancel ? '取消' : '停止'}
            </button>
          </div>

          {error && (
            <div className="error-box" role="alert">
              <strong>出错了：</strong>
              {error.message}
            </div>
          )}

          <MarkerPanel
            status={status}
            canMark={canMark}
            liveMarkers={liveMarkers}
            onAdd={addMarker}
          />
        </div>
      </section>

      <section className="takes" aria-label="成片列表">
        <div className="takes-head">
          <h2>本页成片（{takes.length}）</h2>
          <button
            type="button"
            className="btn btn-download"
            onClick={() => selectedTake && void downloadTake(selectedTake)}
            disabled={!selectedTake}
          >
            下载交付版
          </button>
        </div>
        {takes.length === 0 ? (
          <p className="hint">还没有成片。停止录制后才会在此生成。</p>
        ) : (
          <div className="take-grid">
            {takes
              .slice()
              .reverse()
              .map((take) => (
                <TakeReplay
                  key={take.id}
                  take={take}
                  selected={selectedTake?.id === take.id}
                  onSelect={() => selectTake(take.id)}
                  onDelete={() => deleteTake(take.id)}
                />
              ))}
          </div>
        )}
      </section>
    </main>
  )
}
