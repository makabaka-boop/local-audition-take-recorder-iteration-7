import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAuditionRecorder } from './useAuditionRecorder'
import { FakeMediaRecorder, FakeTrack } from '../test/fakes'

/**
 * 设备枚举与热插拔的交错验收（hook 层）：
 * - 可控枚举返回顺序：较早的枚举在较新的设备变更之后才返回时，旧清单作废；
 * - 空闲时的明确选择在设备仍可用时保持，设备消失时给出“下一条”的明确提示；
 * - 授权等待/录制/暂停期间设备变更不改写本次冻结设备，且不污染下一条选择，
 *   取流约束始终精确落在开拍时冻结的设备上；
 * - 成片冻结实际设备身份；旧成片/交付选择/三模式全部兼容。
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

interface ControllableApi {
  /** 让最早一次枚举以指定清单返回（FIFO） */
  resolveEnumeration: (devices: DeviceDef[]) => void
  /** 让第 index 个挂起枚举（0 起算，按发起顺序）以指定清单返回，用于乱序 */
  resolveEnumerationAt: (index: number, devices: DeviceDef[]) => void
  /** 当前挂起的枚举请求数 */
  pendingEnumCount: () => number
  /** 主动派发一次 devicechange（随后必然发起新枚举） */
  emitDeviceChange: () => void
  enumerateCalls: () => number
  getUserMedia: ReturnType<typeof vi.fn>
  pendingPermissions: Pending[]
  grant: () => void
  deny: (err?: Error) => void
}

function installControllable(opts?: {
  manualPermissions?: boolean
  missingKinds?: Array<'audio' | 'video'>
}): ControllableApi {
  let enumCalls = 0
  const pendingEnums: Array<(devices: DeviceDef[]) => void> = []
  const deviceChangeListeners: Array<() => void> = []
  const pendingPermissions: Pending[] = []
  const missing = new Set(opts?.missingKinds ?? [])

  const tracksFor = (constraints?: MediaStreamConstraints): FakeTrack[] => {
    const set: FakeTrack[] = []
    if (constraints?.video !== false) {
      if (missing.has('video'))
        throw new DOMException('no cam', 'NotFoundError')
      set.push(new FakeTrack('video'))
    }
    if (constraints?.audio !== false) {
      if (missing.has('audio'))
        throw new DOMException('no mic', 'NotFoundError')
      set.push(new FakeTrack('audio'))
    }
    return set
  }

  const enumerateDevices = vi.fn(() => {
    enumCalls++
    return new Promise<MediaDeviceInfo[]>((resolve) => {
      pendingEnums.push((devices) =>
        resolve(
          devices.map((d) => ({
            ...d,
            toJSON: () => d,
          })) as unknown as MediaDeviceInfo[],
        ),
      )
    })
  })

  const getUserMedia = vi.fn((constraints?: MediaStreamConstraints) => {
    if (opts?.manualPermissions) {
      return new Promise<MediaStream>((resolve, reject) => {
        pendingPermissions.push({ constraints, resolve, reject })
      })
    }
    try {
      const set = tracksFor(constraints)
      return Promise.resolve({ getTracks: () => set } as unknown as MediaStream)
    } catch (err) {
      return Promise.reject(err)
    }
  })

  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: {
      enumerateDevices,
      getUserMedia,
      addEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === 'devicechange') deviceChangeListeners.push(listener)
      }),
      removeEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === 'devicechange') {
          const i = deviceChangeListeners.indexOf(listener)
          if (i >= 0) deviceChangeListeners.splice(i, 1)
        }
      }),
    },
  })

  return {
    pendingEnumCount: () => pendingEnums.length,
    emitDeviceChange: () => {
      for (const l of [...deviceChangeListeners]) l()
    },
    enumerateCalls: () => enumCalls,
    getUserMedia,
    pendingPermissions,
    resolveEnumeration: (devices) => {
      const resolve = pendingEnums.shift()
      if (!resolve) throw new Error('没有等待中的枚举请求')
      resolve(devices)
    },
    resolveEnumerationAt: (index, devices) => {
      const resolve = pendingEnums[index]
      if (!resolve) throw new Error(`第 ${index} 个枚举不在等待中`)
      pendingEnums.splice(index, 1)
      resolve(devices)
    },
    grant: () => {
      const item = pendingPermissions.shift()
      if (!item) throw new Error('没有等待中的授权请求')
      const set = tracksFor(item.constraints)
      item.resolve({ getTracks: () => set } as unknown as MediaStream)
    },
    deny: (err) =>
      pendingPermissions
        .shift()
        ?.reject(err ?? new DOMException('denied', 'NotAllowedError')),
  }
}

const CAMS = {
  cam1: { deviceId: 'cam1', kind: 'videoinput', label: '摄像头 A' },
  cam2: { deviceId: 'cam2', kind: 'videoinput', label: '摄像头 B（新接入）' },
}
const MICS = {
  mic1: { deviceId: 'mic1', kind: 'audioinput', label: '麦克风 A' },
  mic2: { deviceId: 'mic2', kind: 'audioinput', label: '麦克风 B（新接入）' },
}

type RecResult = { current: ReturnType<typeof useAuditionRecorder> }

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** 录制一条成片并停止落定（手动授权模式由 grant 参数放行） */
async function shootTake(result: RecResult, api: ControllableApi, content: string) {
  act(() => result.current.start())
  await flush()
  if (api.pendingPermissions.length > 0) {
    act(() => api.grant())
    await flush()
  }
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

beforeEach(() => {
  FakeMediaRecorder.reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('枚举竞态：迟到清单不得覆盖最新设备事件', () => {
  it('较早枚举在设备变更之后才返回：旧清单丢弃，下拉框与明确选择都不被覆盖', async () => {
    const api = installControllable({ manualPermissions: true })
    const { result } = renderHook(() => useAuditionRecorder())
    await flush()
    expect(api.enumerateCalls()).toBe(1)

    // 初次枚举先返回两份设备
    await act(async () => {
      api.resolveEnumeration([CAMS.cam1, MICS.mic1])
      await Promise.resolve()
    })
    act(() => result.current.setVideoDeviceId('cam1'))

    // 设备变更：新枚举发起（#2），但先让一个更晚的设备变更再发起 #3
    act(() => api.emitDeviceChange())
    act(() => api.emitDeviceChange())
    expect(api.pendingEnumCount()).toBe(2)

    // 最后一次枚举（#3，挂起队列 index=1）先返回新清单（含 cam2）
    await act(async () => {
      api.resolveEnumerationAt(1, [CAMS.cam1, CAMS.cam2, MICS.mic1])
      await Promise.resolve()
    })
    expect(result.current.devices.map((d) => d.deviceId)).toEqual([
      'cam1',
      'cam2',
      'mic1',
    ])

    // 导演在新清单中明确选定新设备
    act(() => result.current.setVideoDeviceId('cam2'))
    expect(result.current.videoDeviceId).toBe('cam2')

    // 较早的 #2 枚举（队列 index=0）迟到返回旧清单：必须丢弃
    await act(async () => {
      api.resolveEnumerationAt(0, [CAMS.cam1, MICS.mic1])
      await Promise.resolve()
    })
    expect(result.current.devices.map((d) => d.deviceId)).toEqual([
      'cam1',
      'cam2',
      'mic1',
    ])
    expect(result.current.videoDeviceId).toBe('cam2')
  })

  it('成片收尾触发的枚举若迟到，也不能覆盖随后设备变更拿到的新清单', async () => {
    const api = installControllable({ manualPermissions: true })
    const { result } = renderHook(() => useAuditionRecorder())
    await flush()
    await act(async () => {
      api.resolveEnumeration([CAMS.cam1, MICS.mic1])
      await Promise.resolve()
    })

    await shootTake(result, api, 'take')
    expect(result.current.takes).toHaveLength(1)

    // onSettled 已发起一次收尾枚举（挂起中）
    expect(api.pendingEnumCount()).toBe(1)
    // 收尾枚举未决时热插拔：devicechange 发起更新的枚举
    act(() => api.emitDeviceChange())
    expect(api.pendingEnumCount()).toBe(2)

    // 较新的设备变更枚举（index=1）先回：cam2 出现
    await act(async () => {
      api.resolveEnumerationAt(1, [CAMS.cam1, CAMS.cam2, MICS.mic1])
      await Promise.resolve()
    })
    expect(result.current.devices.map((d) => d.deviceId)).toContain('cam2')

    // 收尾枚举（index=0）迟到返回旧清单：丢弃
    await act(async () => {
      api.resolveEnumerationAt(0, [CAMS.cam1, MICS.mic1])
      await Promise.resolve()
    })
    expect(result.current.devices.map((d) => d.deviceId)).toContain('cam2')
    expect(result.current.videoDeviceId).toBe('cam1')
  })
})

describe('空闲选择的保持与设备消失提示', () => {
  it('明确选择在设备仍可用时始终保持，不被新枚举重置为默认', async () => {
    const api = installControllable({ manualPermissions: true })
    const { result } = renderHook(() => useAuditionRecorder())
    await flush()
    await act(async () => {
      api.resolveEnumeration([CAMS.cam1, CAMS.cam2, MICS.mic1, MICS.mic2])
      await Promise.resolve()
    })
    expect(result.current.videoDeviceId).toBe('cam1')

    act(() => result.current.setVideoDeviceId('cam2'))
    act(() => result.current.setAudioDeviceId('mic2'))
    expect(result.current.videoDeviceId).toBe('cam2')
    expect(result.current.audioDeviceId).toBe('mic2')
    expect(result.current.videoNotice).toBe('')

    // 设备变更后清单刷新（设备都在）：选择与提示保持
    act(() => api.emitDeviceChange())
    await act(async () => {
      api.resolveEnumeration([CAMS.cam1, CAMS.cam2, MICS.mic1, MICS.mic2])
      await Promise.resolve()
    })
    expect(result.current.videoDeviceId).toBe('cam2')
    expect(result.current.audioDeviceId).toBe('mic2')
    expect(result.current.videoNotice).toBe('')
    expect(result.current.audioNotice).toBe('')
  })

  it('所选摄像头被拔除：自动落到同类首个可用设备，明确提示下一条所用设备；下一条取流精确', async () => {
    const api = installControllable({ manualPermissions: true })
    const { result } = renderHook(() => useAuditionRecorder())
    await flush()
    await act(async () => {
      api.resolveEnumeration([CAMS.cam1, CAMS.cam2, MICS.mic1])
      await Promise.resolve()
    })
    act(() => result.current.setVideoDeviceId('cam2'))
    expect(result.current.videoDeviceId).toBe('cam2')

    // 拔掉 cam2：新清单不含它，但仍带其 label 的引用来自上一份选择快照
    act(() => api.emitDeviceChange())
    await act(async () => {
      api.resolveEnumeration([CAMS.cam1, MICS.mic1])
      await Promise.resolve()
    })
    expect(result.current.videoDeviceId).toBe('cam1')
    expect(result.current.videoNotice).toContain(CAMS.cam2.label)
    expect(result.current.videoNotice).toContain(CAMS.cam1.label)
    expect(result.current.videoNotice).toContain('下一条 take')

    // 下一条 take 的取流约束落到 cam1（不是已拔除的 cam2）
    act(() => result.current.start())
    await flush()
    expect(api.pendingPermissions[0].constraints).toEqual({
      video: { deviceId: { exact: 'cam1' } },
      audio: { deviceId: { exact: 'mic1' } },
    })
    act(() => api.grant())
    await flush()
    expect(result.current.status).toBe('recording')
    const rec = FakeMediaRecorder.instances[0]
    await act(async () => {
      rec.emitData(['on-cam1'])
      result.current.stop()
      rec.emitStop()
      await Promise.resolve()
    })
    // 成片记录实际设备 cam1
    expect(result.current.takes[0].videoDevice?.id).toBe('cam1')
    expect(result.current.takes[0].audioDevice?.id).toBe('mic1')
  })

  it('该类设备全部消失：待选退回系统默认并提示；仅视频模式不请求麦克风，照常成片', async () => {
    const api = installControllable({ manualPermissions: true })
    const { result } = renderHook(() => useAuditionRecorder())
    await flush()
    await act(async () => {
      api.resolveEnumeration([CAMS.cam1, MICS.mic1])
      await Promise.resolve()
    })

    // 麦克风全部拔除
    act(() => api.emitDeviceChange())
    await act(async () => {
      api.resolveEnumeration([CAMS.cam1])
      await Promise.resolve()
    })
    expect(result.current.audioDeviceId).toBe('')
    expect(result.current.audioNotice).toContain('系统默认')

    // 切到仅视频：不请求麦克风，授权放行后正常录制
    act(() => result.current.setMode('video-only'))
    act(() => result.current.start())
    await flush()
    expect(api.pendingPermissions[0].constraints).toEqual({
      video: { deviceId: { exact: 'cam1' } },
      audio: false,
    })
    act(() => api.grant())
    await flush()
    expect(result.current.status).toBe('recording')
    const rec = FakeMediaRecorder.instances[0]
    await act(async () => {
      rec.emitData(['vision'])
      result.current.stop()
      rec.emitStop()
      await Promise.resolve()
    })
    expect(result.current.takes[0].videoDevice?.id).toBe('cam1')
    expect(result.current.takes[0].audioDevice).toBeNull()
  })

  it('设备重新接回后旧提示清除，导演可重新明确选择', async () => {
    const api = installControllable({ manualPermissions: true })
    const { result } = renderHook(() => useAuditionRecorder())
    await flush()
    await act(async () => {
      api.resolveEnumeration([CAMS.cam1, CAMS.cam2, MICS.mic1])
      await Promise.resolve()
    })
    act(() => result.current.setVideoDeviceId('cam2'))

    act(() => api.emitDeviceChange())
    await act(async () => {
      api.resolveEnumeration([CAMS.cam1, MICS.mic1])
      await Promise.resolve()
    })
    expect(result.current.videoNotice).not.toBe('')
    expect(result.current.videoDeviceId).toBe('cam1')

    // cam2 重新接回（此时待选已自动落到 cam1，提示清除）
    act(() => api.emitDeviceChange())
    await act(async () => {
      api.resolveEnumeration([CAMS.cam1, CAMS.cam2, MICS.mic1])
      await Promise.resolve()
    })
    expect(result.current.videoNotice).toBe('')

    act(() => result.current.setVideoDeviceId('cam2'))
    expect(result.current.videoDeviceId).toBe('cam2')
    expect(result.current.videoNotice).toBe('')
  })
})

describe('授权等待 / 录制 / 暂停期间的设备变更', () => {
  it('starting（授权未决）设备变更：本次冻结设备与约束不变，界面名称不被改写', async () => {
    const api = installControllable({ manualPermissions: true })
    const { result } = renderHook(() => useAuditionRecorder())
    await flush()
    await act(async () => {
      api.resolveEnumeration([CAMS.cam1, MICS.mic1])
      await Promise.resolve()
    })

    act(() => result.current.start())
    await flush()
    expect(result.current.status).toBe('starting')
    expect(result.current.activeVideoDevice?.id).toBe('cam1')
    expect(result.current.activeVideoDevice?.label).toBe('摄像头 A')

    // 授权等待期间热插拔：接入 cam2、mic1 被 mic2 替换
    act(() => api.emitDeviceChange())
    await act(async () => {
      api.resolveEnumeration([CAMS.cam1, CAMS.cam2, MICS.mic2])
      await Promise.resolve()
    })

    // 本次冻结设备不变；冻结的麦克风已离开最新清单，展示名仍为原名
    expect(result.current.activeVideoDevice?.id).toBe('cam1')
    expect(result.current.activeAudioDevice?.id).toBe('mic1')
    expect(result.current.activeAudioDevice?.label).toBe('麦克风 A')

    // 非空闲时手动切换入口无效
    act(() => {
      result.current.setVideoDeviceId('cam2')
      result.current.setAudioDeviceId('mic2')
    })
    expect(result.current.activeVideoDevice?.id).toBe('cam1')
    expect(result.current.activeAudioDevice?.id).toBe('mic1')

    // 取流约束仍是开拍冻结的 cam1/mic1（请求身份精确，未被静默改写）
    expect(api.pendingPermissions[0].constraints).toEqual({
      video: { deviceId: { exact: 'cam1' } },
      audio: { deviceId: { exact: 'mic1' } },
    })

    act(() => api.grant())
    await flush()
    expect(result.current.status).toBe('recording')
    expect(result.current.activeVideoDevice?.id).toBe('cam1')
    expect(result.current.activeAudioDevice?.id).toBe('mic1')
  })

  it('录制中拔掉本次麦克风：展示与成片身份保持冻结；停止后下一条设备已明确切换并提示', async () => {
    const api = installControllable({ manualPermissions: true })
    const { result } = renderHook(() => useAuditionRecorder())
    await flush()
    await act(async () => {
      api.resolveEnumeration([CAMS.cam1, MICS.mic1, MICS.mic2])
      await Promise.resolve()
    })
    act(() => result.current.setAudioDeviceId('mic1'))

    act(() => result.current.start())
    await flush()
    act(() => api.grant())
    await flush()
    expect(result.current.status).toBe('recording')
    const rec = FakeMediaRecorder.instances[0]

    // 录制中拔掉 mic1（枚举只剩 mic2）
    act(() => api.emitDeviceChange())
    await act(async () => {
      api.resolveEnumeration([CAMS.cam1, MICS.mic2])
      await Promise.resolve()
    })

    // 本次实际设备不变，展示不漂移
    expect(result.current.activeAudioDevice?.id).toBe('mic1')
    expect(result.current.activeAudioDevice?.label).toBe('麦克风 A')
    // “下一条”将使用 mic2，并有明确提示
    expect(result.current.audioDeviceId).toBe('mic2')
    expect(result.current.audioNotice).toContain('下一条 take')
    expect(result.current.audioNotice).toContain(MICS.mic2.label)

    // 暂停期间再来一次设备变更，仍不影响本次
    act(() => result.current.pause())
    expect(result.current.status).toBe('paused')
    act(() => api.emitDeviceChange())
    await act(async () => {
      api.resolveEnumeration([CAMS.cam1, MICS.mic2])
      await Promise.resolve()
    })
    expect(result.current.activeAudioDevice?.id).toBe('mic1')

    // 继续并停止：成片冻结的实际设备是 mic1
    act(() => result.current.resume())
    await act(async () => {
      rec.emitData(['frozen-mic'])
      result.current.stop()
      rec.emitStop()
      await Promise.resolve()
    })
    const take = result.current.takes[0]
    expect(take.audioDevice?.id).toBe('mic1')
    expect(take.videoDevice?.id).toBe('cam1')

    // 停止后开下一条：沿用已对账的 mic2（不会再请求已拔除的 mic1）
    expect(result.current.audioDeviceId).toBe('mic2')
    act(() => result.current.start())
    await flush()
    expect(api.pendingPermissions[0].constraints).toEqual({
      video: { deviceId: { exact: 'cam1' } },
      audio: { deviceId: { exact: 'mic2' } },
    })
  })

  it('录制中接入新摄像头：本次仍用旧摄像头成片，新设备出现在清单供下一条选择', async () => {
    const api = installControllable({ manualPermissions: true })
    const { result } = renderHook(() => useAuditionRecorder())
    await flush()
    await act(async () => {
      api.resolveEnumeration([CAMS.cam1, MICS.mic1])
      await Promise.resolve()
    })

    act(() => result.current.start())
    await flush()
    act(() => api.grant())
    await flush()
    const rec = FakeMediaRecorder.instances[0]

    act(() => api.emitDeviceChange())
    await act(async () => {
      api.resolveEnumeration([CAMS.cam1, CAMS.cam2, MICS.mic1])
      await Promise.resolve()
    })
    // 本次冻结 cam1；待选仍是 cam1（明确选择仍可用，保持不变）
    expect(result.current.activeVideoDevice?.id).toBe('cam1')
    expect(result.current.videoDeviceId).toBe('cam1')
    expect(result.current.videoNotice).toBe('')
    expect(result.current.devices.map((d) => d.deviceId)).toContain('cam2')

    await act(async () => {
      rec.emitData(['still-cam1'])
      result.current.stop()
      rec.emitStop()
      await Promise.resolve()
    })
    expect(result.current.takes[0].videoDevice?.id).toBe('cam1')

    // 停止后明确改选 cam2，下一条精确取 cam2
    act(() => result.current.setVideoDeviceId('cam2'))
    act(() => result.current.start())
    await flush()
    expect(api.pendingPermissions[0].constraints).toEqual({
      video: { deviceId: { exact: 'cam2' } },
      audio: { deviceId: { exact: 'mic1' } },
    })
  })
})

describe('失败提示与旧素材兼容', () => {
  it('所选设备已拔除时开拍失败：明确报错且不产生成片，旧成片与交付选择保留', async () => {
    const api = installControllable({ manualPermissions: true })
    const { result } = renderHook(() => useAuditionRecorder())
    await flush()
    await act(async () => {
      api.resolveEnumeration([CAMS.cam1, CAMS.cam2, MICS.mic1])
      await Promise.resolve()
    })
    await shootTake(result, api, 'old-take')
    const oldTake = result.current.takes[0]
    expect(result.current.selectedTake?.id).toBe(oldTake.id)

    // 导演选 cam2，随后 cam2 被拔除但枚举尚未刷新（极端：直接开拍即失败）。
    act(() => result.current.setVideoDeviceId('cam2'))
    act(() => result.current.start())
    await flush()
    expect(api.pendingPermissions[0].constraints).toEqual({
      video: { deviceId: { exact: 'cam2' } },
      audio: { deviceId: { exact: 'mic1' } },
    })
    await act(async () => {
      api.deny(new DOMException('Requested device not found', 'NotFoundError'))
      await Promise.resolve()
    })
    expect(result.current.status).toBe('idle')
    expect(result.current.error?.code).toBe('start-failed')
    expect(result.current.takes.map((t) => t.id)).toEqual([oldTake.id])
    expect(result.current.selectedTake?.id).toBe(oldTake.id)
  })

  it('设备热插拔交错后，三种模式的成片各自冻结正确设备身份且互不污染', async () => {
    const api = installControllable({ manualPermissions: true })
    const { result } = renderHook(() => useAuditionRecorder())
    await flush()
    await act(async () => {
      api.resolveEnumeration([CAMS.cam1, CAMS.cam2, MICS.mic1, MICS.mic2])
      await Promise.resolve()
    })

    // av：选 cam2 + mic2
    act(() => result.current.setVideoDeviceId('cam2'))
    act(() => result.current.setAudioDeviceId('mic2'))
    await shootTake(result, api, 'av')
    expect(result.current.takes.at(-1)?.mode).toBe('av')
    expect(result.current.takes.at(-1)?.videoDevice?.id).toBe('cam2')
    expect(result.current.takes.at(-1)?.audioDevice?.id).toBe('mic2')

    // 录制间隙设备变更：每条 take 收尾的枚举与两次 devicechange 交错。
    // 先排空 onSettled 的收尾枚举（返回完整清单，选择仍在→保持）。
    expect(api.pendingEnumCount()).toBe(1)
    await act(async () => {
      api.resolveEnumeration([CAMS.cam1, CAMS.cam2, MICS.mic1, MICS.mic2])
      await Promise.resolve()
    })

    act(() => api.emitDeviceChange())
    act(() => api.emitDeviceChange())
    expect(api.pendingEnumCount()).toBe(2)
    await act(async () => {
      // 较新枚举（最后发起，index=1）先回完整清单
      api.resolveEnumerationAt(1, [
        CAMS.cam1,
        CAMS.cam2,
        MICS.mic1,
        MICS.mic2,
      ])
      await Promise.resolve()
    })
    // 较早枚举（index=0）迟到返回缺设备旧清单：作废
    await act(async () => {
      api.resolveEnumerationAt(0, [CAMS.cam1, MICS.mic1])
      await Promise.resolve()
    })
    expect(result.current.videoDeviceId).toBe('cam2')
    expect(result.current.audioDeviceId).toBe('mic2')

    // video-only：只冻结视频设备
    act(() => result.current.setMode('video-only'))
    await shootTake(result, api, 'video')
    const vTake = result.current.takes.at(-1)!
    expect(vTake.mode).toBe('video-only')
    expect(vTake.videoDevice?.id).toBe('cam2')
    expect(vTake.audioDevice).toBeNull()

    // audio-only：只冻结音频设备
    act(() => result.current.setMode('audio-only'))
    await shootTake(result, api, 'audio')
    const aTake = result.current.takes.at(-1)!
    expect(aTake.mode).toBe('audio-only')
    expect(aTake.videoDevice).toBeNull()
    expect(aTake.audioDevice?.id).toBe('mic2')

    // 三条成片并存，交付选择切换兼容
    expect(result.current.takes).toHaveLength(3)
    act(() => result.current.selectTake(result.current.takes[0].id))
    expect(result.current.selectedTake?.id).toBe(result.current.takes[0].id)
  })

  it('挂载时无该类设备：静默使用系统默认，不产生误导提示；取流约束为 true', async () => {
    const api = installControllable({ manualPermissions: true })
    const { result } = renderHook(() => useAuditionRecorder())
    await flush()
    await act(async () => {
      api.resolveEnumeration([])
      await Promise.resolve()
    })
    expect(result.current.videoDeviceId).toBe('')
    expect(result.current.audioDeviceId).toBe('')
    expect(result.current.videoNotice).toBe('')
    expect(result.current.audioNotice).toBe('')

    act(() => result.current.start())
    await flush()
    expect(api.pendingPermissions[0].constraints).toEqual({
      video: true,
      audio: true,
    })
  })
})
