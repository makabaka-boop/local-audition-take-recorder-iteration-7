import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAuditionRecorder } from './useAuditionRecorder'
import { FakeMediaRecorder, FakeTrack } from '../test/fakes'

/**
 * 瞬间标记 hook 集成测试：
 * - canMark 只在 recording 为真；addMarker 结局与文案直通 UI
 * - 实时标记列表 liveMarkers 在录制中追加、停止后清空（改由 Take.markers）
 * - 暂停边界时间不漂移、同毫秒次序、停止超时/设备中断裁剪
 * - 空 Blob 不产生带标记 take；切换 take 各带各的标记
 */

interface Pending {
  constraints?: MediaStreamConstraints
  resolve: (stream: MediaStream) => void
  reject: (err: unknown) => void
}

function installGlobals() {
  const pending: Pending[] = []
  const tracksFor = (constraints?: MediaStreamConstraints): FakeTrack[] => {
    const set: FakeTrack[] = []
    if (constraints?.video !== false) set.push(new FakeTrack('video'))
    if (constraints?.audio !== false) set.push(new FakeTrack('audio'))
    return set
  }
  const enumerateDevices = vi.fn(async () => [
    { deviceId: 'cam1', kind: 'videoinput', label: '摄像头 A', toJSON() {} },
    { deviceId: 'mic1', kind: 'audioinput', label: '麦克风 A', toJSON() {} },
  ])
  const getUserMedia = vi.fn((constraints?: MediaStreamConstraints) => {
    return new Promise<MediaStream>((resolve, reject) => {
      pending.push({ constraints, resolve, reject })
    })
  })
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: {
      enumerateDevices,
      getUserMedia,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  })
  return {
    pending,
    grant: () => {
      const item = pending.shift()
      if (!item) throw new Error('无等待中的授权')
      const tracks = tracksFor(item.constraints)
      item.resolve({ getTracks: () => tracks } as unknown as MediaStream)
    },
    deny: () =>
      pending
        .shift()
        ?.reject(new DOMException('denied', 'NotAllowedError')),
  }
}

/** 手动授权 + 假定时器：排空微任务（waitFor 依赖定时器，此处不可用） */
async function flushMicrotasks(times = 6) {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve()
  })
}

async function startRecording(
  result: { current: ReturnType<typeof useAuditionRecorder> },
  g: ReturnType<typeof installGlobals>,
) {
  act(() => result.current.start())
  expect(result.current.status).toBe('starting')
  await act(async () => {
    g.grant()
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(result.current.status).toBe('recording')
  return FakeMediaRecorder.instances[
    FakeMediaRecorder.instances.length - 1
  ]
}

async function emitAndStop(
  result: { current: ReturnType<typeof useAuditionRecorder> },
  rec: FakeMediaRecorder,
  content = 'data',
) {
  act(() => {
    rec.emitData([content])
    result.current.stop()
    rec.emitStop()
  })
  // 停止后 onSettled 异步刷新设备清单：排空其微任务，避免 act 告警
  await flushMicrotasks(3)
}

beforeEach(() => {
  FakeMediaRecorder.reset()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useAuditionRecorder 瞬间标记', () => {
  it('canMark 只在 recording 为真；idle/starting/paused/stopping 均为假', async () => {
    const g = installGlobals()
    const { result } = renderHook(() => useAuditionRecorder())
    await flushMicrotasks()
    expect(result.current.status).toBe('idle')
    expect(result.current.canMark).toBe(false)

    act(() => result.current.start())
    expect(result.current.status).toBe('starting')
    expect(result.current.canMark).toBe(false)

    await act(async () => {
      g.grant()
      await Promise.resolve()
    })
    expect(result.current.status).toBe('recording')
    expect(result.current.canMark).toBe(true)

    act(() => result.current.pause())
    expect(result.current.status).toBe('paused')
    expect(result.current.canMark).toBe(false)

    act(() => result.current.resume())
    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    act(() => {
      result.current.stop()
    })
    expect(result.current.status).toBe('stopping')
    expect(result.current.canMark).toBe(false)
    act(() => {
      rec.emitData(['d'])
      rec.emitStop()
    })
    expect(result.current.status).toBe('idle')
    expect(result.current.canMark).toBe(false)
    await flushMicrotasks(3)
  })

  it('录制中 addMarker 成功：liveMarkers 追加，停止后清空并冻结进 take', async () => {
    const g = installGlobals()
    const { result } = renderHook(() => useAuditionRecorder())
    await flushMicrotasks()
    const rec = await startRecording(result, g)

    act(() => vi.advanceTimersByTime(1200))
    let r: ReturnType<typeof result.current.addMarker>
    act(() => {
      r = result.current.addMarker('  回看这一段  ')
    })
    expect(r!.ok).toBe(true)
    expect(result.current.liveMarkers).toHaveLength(1)
    expect(result.current.liveMarkers[0].label).toBe('回看这一段')
    expect(result.current.liveMarkers[0].timeMs).toBe(1200)

    await emitAndStop(result, rec)
    expect(result.current.status).toBe('idle')
    // 实时镜像随会话结束清空
    expect(result.current.liveMarkers).toEqual([])
    // 标记随 take 冻结
    const take = result.current.takes[0]
    expect(take.markers).toEqual([
      { label: '回看这一段', timeMs: 1200, order: 0 },
    ])
  })

  it('暂停/等待权限/停止中/已结束写入均被拒绝并给出文案，不产生标记', async () => {
    const g = installGlobals()
    const { result } = renderHook(() => useAuditionRecorder())
    await flushMicrotasks()

    // idle
    let rejected = result.current.addMarker('未开始')
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.reason).toBe('not-recording')

    // starting
    act(() => result.current.start())
    rejected = result.current.addMarker('授权中')
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.reason).toBe('starting')

    await act(async () => {
      g.grant()
      await Promise.resolve()
    })
    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]

    // paused
    act(() => result.current.pause())
    rejected = result.current.addMarker('暂停中')
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.reason).toBe('paused')
    act(() => result.current.resume())

    // stopping
    act(() => result.current.stop())
    rejected = result.current.addMarker('停止中')
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.reason).toBe('stopping')
    act(() => {
      rec.emitData(['d'])
      rec.emitStop()
    })

    // 已结束
    rejected = result.current.addMarker('结束后')
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.reason).toBe('not-recording')
    expect(result.current.takes[0].markers).toEqual([])
    await flushMicrotasks(3)
  })

  it('暂停边界：标记时间排除暂停；同毫秒按创建次序', async () => {
    const g = installGlobals()
    const { result } = renderHook(() => useAuditionRecorder())
    await flushMicrotasks()
    const rec = await startRecording(result, g)

    act(() => vi.advanceTimersByTime(1000))
    act(() => result.current.addMarker('暂停前')) // 1000
    act(() => result.current.pause())
    act(() => vi.advanceTimersByTime(5000)) // 暂停不计
    act(() => result.current.resume())
    act(() => vi.advanceTimersByTime(1500))
    // 同一虚拟时刻连续两条
    act(() => {
      result.current.addMarker('同毫秒甲')
      result.current.addMarker('同毫秒乙')
    })

    expect(result.current.liveMarkers.map((m) => m.timeMs)).toEqual([
      1000,
      2500,
      2500,
    ])
    // order 为会话内自增：暂停前=0，同毫秒两条=1、2（同毫秒次序保留）
    expect(result.current.liveMarkers.map((m) => m.order)).toEqual([0, 1, 2])

    await emitAndStop(result, rec)
    expect(result.current.takes[0].durationMs).toBe(2500)
    expect(result.current.takes[0].markers.map((m) => m.label)).toEqual([
      '暂停前',
      '同毫秒甲',
      '同毫秒乙',
    ])
  })

  it('设备中断：标记冻结在中断时刻；重录不串标记', async () => {
    const g = installGlobals()
    const { result } = renderHook(() => useAuditionRecorder())
    await flushMicrotasks()
    const rec1 = await startRecording(result, g)

    act(() => vi.advanceTimersByTime(800))
    act(() => result.current.addMarker('中断条'))
    act(() => rec1.emitData(['pre']))
    // 模拟设备拔除（测试替身未持有轨道引用，用 recorder error 走中断路径）
    act(() => rec1.emitError({ name: 'UnknownError', message: 'device gone' }))
    expect(result.current.status).toBe('stopping')
    act(() => {
      rec1.emitData(['tail'])
      rec1.emitStop()
    })

    expect(result.current.takes).toHaveLength(1)
    expect(result.current.takes[0].reason).toBe('device-interrupted')
    expect(result.current.takes[0].durationMs).toBe(800)
    expect(result.current.takes[0].markers.map((m) => m.label)).toEqual([
      '中断条',
    ])
    expect(result.current.liveMarkers).toEqual([])

    // 重录：实时镜像从空开始
    const rec2 = await startRecording(result, g)
    expect(result.current.liveMarkers).toEqual([])
    act(() => result.current.addMarker('重录条'))
    await emitAndStop(result, rec2, 'retry')
    expect(result.current.takes).toHaveLength(2)
    expect(result.current.takes[1].markers.map((m) => m.label)).toEqual([
      '重录条',
    ])
    expect(result.current.takes[0].markers.map((m) => m.label)).toEqual([
      '中断条',
    ])
  })

  it('停止超时（无 stop 事件）：兜底按冻结时长成片并冻结标记', async () => {
    const g = installGlobals()
    const { result } = renderHook(() => useAuditionRecorder())
    await flushMicrotasks()
    const rec = await startRecording(result, g)

    act(() => vi.advanceTimersByTime(1500))
    act(() => result.current.addMarker('超时前'))
    act(() => rec.emitData(['captured']))
    act(() => result.current.stop())
    expect(result.current.status).toBe('stopping')
    // 编码器始终沉默
    act(() => vi.advanceTimersByTime(10_000))
    expect(result.current.status).toBe('idle')
    expect(result.current.takes).toHaveLength(1)
    expect(result.current.takes[0].durationMs).toBe(1500)
    expect(result.current.takes[0].markers).toEqual([
      { label: '超时前', timeMs: 1500, order: 0 },
    ])
    await flushMicrotasks(3)
  })

  it('空 Blob 不生成带标记 take：empty-take 后可立即重录', async () => {
    const g = installGlobals()
    const { result } = renderHook(() => useAuditionRecorder())
    await flushMicrotasks()
    const rec = await startRecording(result, g)

    act(() => result.current.addMarker('空片标记'))
    act(() => {
      rec.emitEmptyData()
      result.current.stop()
      rec.emitStop()
    })
    expect(result.current.takes).toHaveLength(0)
    expect(result.current.error?.code).toBe('empty-take')
    expect(result.current.liveMarkers).toEqual([])

    const rec2 = await startRecording(result, g)
    expect(result.current.liveMarkers).toEqual([])
    act(() => result.current.addMarker('重录'))
    await emitAndStop(result, rec2, 'retry')
    expect(result.current.takes).toHaveLength(1)
    expect(result.current.takes[0].markers.map((m) => m.label)).toEqual(['重录'])
  })

  it('切换 take 不串标记：两条成片各自携带冻结标记，选择只改 selectedTake', async () => {
    const g = installGlobals()
    const { result } = renderHook(() => useAuditionRecorder())
    await flushMicrotasks()

    const rec1 = await startRecording(result, g)
    act(() => result.current.addMarker('A1'))
    await emitAndStop(result, rec1, 'a')

    const rec2 = await startRecording(result, g)
    act(() => result.current.addMarker('B1'))
    await emitAndStop(result, rec2, 'b')

    expect(result.current.takes).toHaveLength(2)
    expect(result.current.takes[0].markers.map((m) => m.label)).toEqual(['A1'])
    expect(result.current.takes[1].markers.map((m) => m.label)).toEqual(['B1'])

    // 选回第一条：selectedTake 带 A1，第二条仍带 B1（不随选择漂移）
    act(() => result.current.selectTake(result.current.takes[0].id))
    expect(result.current.selectedTake?.markers.map((m) => m.label)).toEqual([
      'A1',
    ])
    act(() => result.current.selectTake(result.current.takes[1].id))
    expect(result.current.selectedTake?.markers.map((m) => m.label)).toEqual([
      'B1',
    ])
    expect(result.current.takes[0].markers.map((m) => m.label)).toEqual(['A1'])
  })
})
