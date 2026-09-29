import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useAuditionRecorder } from './useAuditionRecorder'
import { FakeMediaRecorder, FakeTrack } from '../test/fakes'

/**
 * hook 层测试：通过全局 navigator.mediaDevices / MediaRecorder 替身，
 * 验证设备枚举、授权失败不毁成片、删除/卸载释放资源、空闲才能切设备，
 * 以及三种模式的切换冻结、只取所需轨道与无麦克风的仅视频成片。
 */

interface DeviceDef {
  deviceId: string
  kind: string
  label: string
}

interface Pending {
  constraints?: MediaStreamConstraints
  resolve: (stream: MediaStream) => void
  reject: (err: unknown) => void
}

interface InstalledApi {
  enumerateDevices: ReturnType<typeof vi.fn>
  getUserMedia: ReturnType<typeof vi.fn>
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
  tracks: () => FakeTrack[]
  /** 手动授权模式下等待中的请求 */
  pending: Pending[]
  /** 放行最早一次请求（按约束产轨） */
  grant: () => void
  /** 拒绝最早一次请求 */
  deny: (err?: Error) => void
}

function installGlobals(opts?: {
  devices?: DeviceDef[]
  reject?: Error
  /** 视为物理缺失的设备 kind（请求时抛 NotFoundError） */
  missingKinds?: Array<'audio' | 'video'>
  /** 授权 Promise 手动控制（验证等待授权期间冻结） */
  manualPermissions?: boolean
}): InstalledApi {
  const createdTracks: FakeTrack[] = []
  const pending: Pending[] = []
  const devices = opts?.devices ?? [
    { deviceId: 'cam1', kind: 'videoinput', label: '摄像头 A' },
    { deviceId: 'mic1', kind: 'audioinput', label: '麦克风 A' },
  ]
  const missing = new Set(opts?.missingKinds ?? [])

  const tracksFor = (constraints?: MediaStreamConstraints): FakeTrack[] => {
    const set: FakeTrack[] = []
    if (constraints?.video !== false) {
      if (missing.has('video')) {
        throw new DOMException('no camera', 'NotFoundError')
      }
      set.push(new FakeTrack('video'))
    }
    if (constraints?.audio !== false) {
      if (missing.has('audio')) {
        throw new DOMException('no mic', 'NotFoundError')
      }
      set.push(new FakeTrack('audio'))
    }
    return set
  }

  const enumerateDevices = vi.fn(async () =>
    devices.map((d) => ({ ...d, toJSON: () => d })),
  )
  const getUserMedia = vi.fn((constraints?: MediaStreamConstraints) => {
    if (opts?.manualPermissions) {
      return new Promise<MediaStream>((resolve, reject) => {
        pending.push({ constraints, resolve, reject })
      })
    }
    if (opts?.reject) return Promise.reject(opts.reject)
    let set: FakeTrack[]
    try {
      set = tracksFor(constraints)
    } catch (err) {
      return Promise.reject(err)
    }
    createdTracks.push(...set)
    return Promise.resolve({
      getTracks: () => set,
    } as unknown as MediaStream)
  })
  const addEventListener = vi.fn()
  const removeEventListener = vi.fn()

  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: {
      enumerateDevices,
      getUserMedia,
      addEventListener,
      removeEventListener,
    },
  })

  const grant = () => {
    const item = pending.shift()
    if (!item) throw new Error('无等待中的授权请求')
    const set = tracksFor(item.constraints)
    createdTracks.push(...set)
    item.resolve({ getTracks: () => set } as unknown as MediaStream)
  }
  const deny = (err?: Error) => {
    pending
      .shift()
      ?.reject(err ?? new DOMException('denied', 'NotAllowedError'))
  }

  return {
    enumerateDevices,
    getUserMedia,
    addEventListener,
    removeEventListener,
    tracks: () => createdTracks,
    pending,
    grant,
    deny,
  }
}

beforeEach(() => {
  FakeMediaRecorder.reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function shoot(
  result: { current: ReturnType<typeof useAuditionRecorder> },
  content = 'x',
) {
  await act(async () => {
    await result.current.start()
  })
  const rec = FakeMediaRecorder.instances[
    FakeMediaRecorder.instances.length - 1
  ]
  await act(async () => {
    rec.emitData([content])
    result.current.stop()
    rec.emitStop()
    await Promise.resolve()
    await Promise.resolve()
  })
  return rec
}

describe('useAuditionRecorder', () => {
  it('挂载即枚举设备并识别三模式编码，默认音视频且可开拍', async () => {
    const api = installGlobals({})
    const { result } = renderHook(() => useAuditionRecorder())
    await waitFor(() => expect(api.enumerateDevices).toHaveBeenCalled())
    expect(result.current.videoDeviceId).toBe('cam1')
    expect(result.current.audioDeviceId).toBe('mic1')
    expect(result.current.mode).toBe('av')
    expect(result.current.mimeByMode).toEqual({
      av: 'video/webm;codecs=vp9,opus',
      'video-only': 'video/webm;codecs=vp9',
      'audio-only': 'audio/webm;codecs=opus',
    })
    expect(result.current.supportedMimeType).toBe(
      'video/webm;codecs=vp9,opus',
    )
    expect(result.current.canStart).toBe(true)
  })

  it('授权被拒绝：报错且回 idle，不产生 take、不释放旧成片', async () => {
    const api = installGlobals({
      reject: new DOMException('denied', 'NotAllowedError'),
    })
    const { result } = renderHook(() => useAuditionRecorder())
    await waitFor(() => expect(api.enumerateDevices).toHaveBeenCalled())

    await act(async () => {
      await result.current.start()
    })
    expect(result.current.error?.code).toBe('permission-denied')
    expect(result.current.status).toBe('idle')
    expect(result.current.takes).toHaveLength(0)
  })

  it('录制中不能切换设备，停止后恢复可切换', async () => {
    installGlobals({})
    const { result } = renderHook(() => useAuditionRecorder())
    await waitFor(() => expect(result.current.status).toBe('idle'))

    await act(async () => {
      await result.current.start()
    })
    expect(result.current.status).toBe('recording')
    expect(result.current.canSwitchDevice).toBe(false)

    act(() => {
      result.current.setVideoDeviceId('other')
      result.current.setAudioDeviceId('other')
    })
    expect(result.current.videoDeviceId).toBe('cam1')
    expect(result.current.audioDeviceId).toBe('mic1')

    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    await act(async () => {
      rec.emitData(['x'])
      result.current.stop()
      rec.emitStop()
      await Promise.resolve()
    })
    expect(result.current.status).toBe('idle')
    expect(result.current.canSwitchDevice).toBe(true)
    expect(result.current.takes).toHaveLength(1)
  })

  it('删除 take 会撤销其对象 URL', async () => {
    installGlobals({})
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL')
    const { result } = renderHook(() => useAuditionRecorder())

    await shoot(result, 'a')
    const take = result.current.takes[0]
    expect(take).toBeTruthy()

    act(() => {
      result.current.deleteTake(take.id)
    })
    expect(result.current.takes).toHaveLength(0)
    expect(revokeSpy).toHaveBeenCalledWith(take.url)
  })

  it('卸载时停止全部轨道并撤销所有成片 URL', async () => {
    installGlobals({})
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL')
    const { result, unmount } = renderHook(() => useAuditionRecorder())

    await shoot(result, 'x')
    const url = result.current.takes[0].url

    unmount()
    expect(revokeSpy).toHaveBeenCalledWith(url)
    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    expect(rec.onstop).toBeNull()
  })

  it('新 take 失败不破坏已选交付版', async () => {
    const g = installGlobals({})
    const { result } = renderHook(() => useAuditionRecorder())
    await shoot(result, 'first')
    const firstTake = result.current.takes[0]
    expect(result.current.selectedTake?.id).toBe(firstTake.id)

    g.getUserMedia.mockImplementation(async () => {
      throw new DOMException('denied', 'NotAllowedError')
    })
    await act(async () => {
      await result.current.start()
    })

    expect(result.current.error?.code).toBe('permission-denied')
    expect(result.current.takes).toHaveLength(1)
    expect(result.current.selectedTake?.id).toBe(firstTake.id)
  })

  it('再次开拍时录制器启动失败：旧 take 与交付版选择原样保留', async () => {
    installGlobals({})
    const { result } = renderHook(() => useAuditionRecorder())
    await shoot(result, 'A')
    expect(result.current.takes).toHaveLength(1)
    const takeA = result.current.takes[0]

    FakeMediaRecorder.startThrows = new DOMException(
      'could not start',
      'InvalidStateError',
    )
    await act(async () => {
      await result.current.start()
    })

    expect(result.current.error?.code).toBe('start-failed')
    expect(result.current.status).toBe('idle')
    expect(result.current.takes).toHaveLength(1)
    expect(result.current.takes[0].id).toBe(takeA.id)
    expect(result.current.selectedTake?.id).toBe(takeA.id)
  })
})

describe('停止落定的确定性结局（hook 集成）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** 假定时器下不能用 waitFor（其轮询依赖定时器）：手动排空微任务 */
  async function flushMicrotasks(times = 5) {
    await act(async () => {
      for (let i = 0; i < times; i++) await Promise.resolve()
    })
  }

  it('授权弹窗未决时可取消：回 idle、无成片无错误，迟到授权不影响，可立即重拍', async () => {
    const g = installGlobals({ manualPermissions: true })
    const { result } = renderHook(() => useAuditionRecorder())
    await flushMicrotasks()
    expect(result.current.canStart).toBe(true)

    await act(async () => {
      result.current.start()
    })
    expect(result.current.status).toBe('starting')

    act(() => {
      result.current.stop()
    })
    expect(result.current.status).toBe('idle')
    expect(result.current.takes).toHaveLength(0)
    expect(result.current.error).toBeNull()

    // 浏览器此后才给出授权结果：流被释放，界面仍空闲
    await act(async () => {
      g.grant()
      await Promise.resolve()
    })
    expect(result.current.status).toBe('idle')
    expect(FakeMediaRecorder.instances).toHaveLength(0)

    // 立即重拍成功
    await act(async () => {
      result.current.start()
      g.grant()
      await Promise.resolve()
    })
    expect(result.current.status).toBe('recording')
  })

  it('录制器始终不发结束事件：兜底后回 idle、释放轨道、成片时长冻结且不含等待', async () => {
    installGlobals({})
    const { result } = renderHook(() => useAuditionRecorder())
    await flushMicrotasks()
    expect(result.current.canStart).toBe(true)

    await act(async () => {
      await result.current.start()
    })
    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    expect(result.current.status).toBe('recording')

    act(() => {
      vi.advanceTimersByTime(1500)
      rec.emitData(['frozen'])
    })

    act(() => {
      result.current.stop()
    })
    expect(result.current.status).toBe('stopping')

    // 编码器不发 stop；推进远超兜底窗口（封装等待不得计入时长）
    act(() => {
      vi.advanceTimersByTime(10_000)
    })

    expect(result.current.status).toBe('idle')
    expect(result.current.takes).toHaveLength(1)
    const take = result.current.takes[0]
    expect(take.durationMs).toBe(1500)
    expect(rec.onstop).toBeNull()

    // 后续录制不再被阻塞
    await act(async () => {
      await result.current.start()
    })
    expect(result.current.status).toBe('recording')
  })
})

describe('模式切换与能力隔离', () => {
  it('空闲可在三模式间切换，仅音频模式展示其实际 MIME', async () => {
    installGlobals({})
    const { result } = renderHook(() => useAuditionRecorder())
    await waitFor(() => expect(result.current.canStart).toBe(true))

    act(() => result.current.setMode('audio-only'))
    expect(result.current.mode).toBe('audio-only')
    expect(result.current.supportedMimeType).toBe('audio/webm;codecs=opus')

    act(() => result.current.setMode('video-only'))
    expect(result.current.mode).toBe('video-only')
    expect(result.current.supportedMimeType).toBe(
      'video/webm;codecs=vp9',
    )
  })

  it('纯 audio/webm 环境：音视频与仅视频被禁用且不可选，仅音频默认可开拍', async () => {
    installGlobals({ devices: [] })
    FakeMediaRecorder.supported = ['audio/webm']
    const { result } = renderHook(() => useAuditionRecorder())
    await waitFor(() =>
      expect(result.current.mimeByMode['audio-only']).toBe('audio/webm'),
    )
    expect(result.current.mimeByMode.av).toBeNull()
    expect(result.current.mimeByMode['video-only']).toBeNull()
    expect(result.current.mimeByMode['audio-only']).toBe('audio/webm')
    // 默认 av 无能力 → 开始按钮禁用
    expect(result.current.canStart).toBe(false)

    // 切到仅音频（仍空闲）后可开拍
    act(() => result.current.setMode('audio-only'))
    expect(result.current.canStart).toBe(true)

    // 切到被禁用的模式不生效
    act(() => result.current.setMode('video-only'))
    expect(result.current.mode).toBe('audio-only')
  })

  it('视频编码不可用时只禁用视频模式，音频模式照常成片并保存模式与 MIME', async () => {
    installGlobals({})
    FakeMediaRecorder.supported = ['audio/webm;codecs=opus', 'audio/webm']
    const { result } = renderHook(() => useAuditionRecorder())
    await waitFor(() =>
      expect(result.current.mimeByMode.av).toBeNull(),
    )

    act(() => result.current.setMode('audio-only'))
    await shoot(result, 'voice')
    const take = result.current.takes[0]
    expect(take.mode).toBe('audio-only')
    expect(take.mimeType).toBe('audio/webm;codecs=opus')
    expect(take.blob.type).toBe('audio/webm;codecs=opus')
  })
})

describe('开拍冻结（hook/UI 层）', () => {
  it('点击开拍先进入 starting：授权等待期间切模式/切设备/重复开始均无效', async () => {
    const g = installGlobals({ manualPermissions: true })
    const { result } = renderHook(() => useAuditionRecorder())
    await waitFor(() => expect(result.current.canStart).toBe(true))

    act(() => result.current.setMode('video-only'))
    await act(async () => {
      result.current.start()
    })
    expect(result.current.status).toBe('starting')
    expect(result.current.activeMode).toBe('video-only')
    expect(result.current.activeMimeType).toBe('video/webm;codecs=vp9')
    expect(g.pending).toHaveLength(1)

    // 授权弹窗未决：重复开始
    await act(async () => {
      result.current.start()
      result.current.start()
    })
    expect(g.pending).toHaveLength(1)

    // 试图切模式 / 切设备：都被冻结挡下
    act(() => {
      result.current.setMode('audio-only')
      result.current.setVideoDeviceId('cam-other')
      result.current.setAudioDeviceId('mic-other')
    })
    expect(result.current.mode).toBe('video-only')
    expect(result.current.activeMode).toBe('video-only')
    expect(result.current.videoDeviceId).toBe('cam1')
    expect(result.current.audioDeviceId).toBe('mic1')
    expect(g.getUserMedia).toHaveBeenCalledTimes(1)

    // 冻结的约束：仅视频 audio:false，video 仍指向原设备
    expect(g.pending[0].constraints).toEqual({
      video: { deviceId: { exact: 'cam1' } },
      audio: false,
    })

    // 放行：按冻结参数成片
    await act(async () => {
      g.grant()
      await Promise.resolve()
    })
    expect(result.current.status).toBe('recording')
    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    expect(rec.mimeType).toBe('video/webm;codecs=vp9')
    await act(async () => {
      rec.emitData(['locked'])
      result.current.stop()
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.status).toBe('idle')
    expect(result.current.activeMode).toBeNull()
    expect(result.current.takes[0].mode).toBe('video-only')

    // 回到 idle 后模式与设备解锁，可切换
    act(() => result.current.setMode('audio-only'))
    expect(result.current.mode).toBe('audio-only')
  })

  it('授权等待期间重复开始不能让取流约束漂移为另一模式（audio-only 迟到切换）', async () => {
    const g = installGlobals({ manualPermissions: true })
    const { result } = renderHook(() => useAuditionRecorder())
    await waitFor(() => expect(result.current.canStart).toBe(true))

    await act(async () => {
      result.current.start() // 默认 av
    })
    expect(g.pending[0].constraints).toEqual({
      video: { deviceId: { exact: 'cam1' } },
      audio: { deviceId: { exact: 'mic1' } },
    })
    act(() => result.current.setMode('audio-only'))
    await act(async () => {
      result.current.start()
    })
    expect(g.getUserMedia).toHaveBeenCalledTimes(1)
    expect(g.pending[0].constraints).toEqual({
      video: { deviceId: { exact: 'cam1' } },
      audio: { deviceId: { exact: 'mic1' } },
    })

    await act(async () => {
      g.grant()
      await Promise.resolve()
    })
    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    expect(rec.mimeType).toBe('video/webm;codecs=vp9,opus')
  })

  it('授权被拒后解锁：保留旧成片与交付选择，可切模式重拍', async () => {
    const g = installGlobals({ manualPermissions: true })
    const { result } = renderHook(() => useAuditionRecorder())

    // 先成片一条 av
    await act(async () => {
      result.current.start()
      g.grant()
      await Promise.resolve()
    })
    const rec1 = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    await act(async () => {
      rec1.emitData(['old'])
      result.current.stop()
      rec1.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })
    const oldId = result.current.takes[0].id

    // 第二次仅音频，授权被拒
    act(() => result.current.setMode('audio-only'))
    await act(async () => {
      result.current.start()
    })
    expect(result.current.status).toBe('starting')
    await act(async () => {
      g.deny()
      await Promise.resolve()
    })
    expect(result.current.status).toBe('idle')
    expect(result.current.error?.code).toBe('permission-denied')
    expect(result.current.takes.map((t) => t.id)).toEqual([oldId])
    expect(result.current.selectedTake?.id).toBe(oldId)
    // 模式选择/能力保留，可再开拍
    expect(result.current.mode).toBe('audio-only')
    expect(result.current.canStart).toBe(true)
  })
})

describe('只取所需轨道：麦克风不可用的仅视频', () => {
  it('物理无麦克风：仅视频取流 audio:false 成功，成片可回放/下载，模式为 video-only', async () => {
    const g = installGlobals({ missingKinds: ['audio'] })
    const { result } = renderHook(() => useAuditionRecorder())
    await waitFor(() => expect(result.current.canStart).toBe(true))

    act(() => result.current.setMode('video-only'))
    await act(async () => {
      await result.current.start()
    })
    expect(result.current.error).toBeNull()
    expect(result.current.status).toBe('recording')
    expect(g.getUserMedia).toHaveBeenCalledWith({
      video: { deviceId: { exact: 'cam1' } },
      audio: false,
    })

    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    await act(async () => {
      rec.emitData(['visual-only'])
      result.current.stop()
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })

    const take = result.current.takes[0]
    expect(take).toBeTruthy()
    expect(take.mode).toBe('video-only')
    expect(take.mimeType).toBe('video/webm;codecs=vp9')
    expect(result.current.selectedTake?.id).toBe(take.id)
    // 交付选择指向该 take：其对象 URL 与非空 Blob 可供回放/下载
    expect(take.url).toBeTruthy()
    expect(take.blob.size).toBeGreaterThan(0)
  })

  it('无摄像头设备时仅音频取 video:false 成功', async () => {
    const g = installGlobals({ missingKinds: ['video'] })
    const { result } = renderHook(() => useAuditionRecorder())
    await waitFor(() => expect(result.current.canStart).toBe(true))
    act(() => result.current.setMode('audio-only'))
    await act(async () => {
      await result.current.start()
    })
    expect(result.current.status).toBe('recording')
    expect(g.getUserMedia).toHaveBeenCalledWith({
      video: false,
      audio: { deviceId: { exact: 'mic1' } },
    })
    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    await act(async () => {
      rec.emitData(['sound-only'])
      result.current.stop()
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.takes[0].mode).toBe('audio-only')
  })
})
