import { describe, expect, it, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from './App'
import { FakeMediaRecorder, FakeTrack } from './test/fakes'

/**
 * 设备枚举/热插拔的页面验收：
 * - 清单反映最后一次有效设备事件（迟到枚举不覆盖下拉选项）；
 * - 授权等待/录制/暂停期间下拉恒显示本次冻结采集设备（即便它已离开最新清单，
 *   补“（本次已锁定）”选项），与实际取流严格一致；
 * - 所选设备消失时明确提示下一条 take 将使用的设备；
 * - 成片卡片展示冻结的实际设备身份；旧成片、交付选择、三模式保持兼容。
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

function installControllable() {
  let enumCalls = 0
  const pendingEnums: Array<(devices: DeviceDef[]) => void> = []
  const deviceChangeListeners: Array<() => void> = []
  const pending: Pending[] = []

  const tracksFor = (constraints?: MediaStreamConstraints): FakeTrack[] => {
    const tracks: FakeTrack[] = []
    if (constraints?.video !== false) tracks.push(new FakeTrack('video'))
    if (constraints?.audio !== false) tracks.push(new FakeTrack('audio'))
    return tracks
  }

  const enumerateDevices = vi.fn(() => {
    enumCalls++
    return new Promise<MediaDeviceInfo[]>((resolve) => {
      pendingEnums.push((devices) =>
        resolve(
          devices.map((d) => ({ ...d, toJSON: () => d })) as unknown as MediaDeviceInfo[],
        ),
      )
    })
  })

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
    enumCalls: () => enumCalls,
    pending,
    resolveEnumeration: (devices: DeviceDef[]) => {
      pendingEnums.shift()?.(devices)
    },
    resolveEnumerationAt: (index: number, devices: DeviceDef[]) => {
      const r = pendingEnums[index]
      pendingEnums.splice(index, 1)
      r?.(devices)
    },
    emitDeviceChange: () => {
      for (const l of [...deviceChangeListeners]) l()
    },
    grant: () => {
      const item = pending.shift()
      if (!item) throw new Error('无等待中的授权')
      const tracks = tracksFor(item.constraints)
      item.resolve({ getTracks: () => tracks } as unknown as MediaStream)
    },
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

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function cameraSelect(): HTMLSelectElement {
  return document.querySelector(
    'select[data-device-kind="videoinput"]',
  ) as HTMLSelectElement
}
function micSelect(): HTMLSelectElement {
  return document.querySelector(
    'select[data-device-kind="audioinput"]',
  ) as HTMLSelectElement
}

describe('设备枚举与热插拔（UI）', () => {
  beforeAll(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() =>
      Promise.resolve(),
    )
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(
      () => undefined,
    )
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(
      () => undefined,
    )
  })

  afterAll(() => {
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    FakeMediaRecorder.reset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('迟到枚举不覆盖下拉选项：新接入设备保留，刚选的新设备不被退回', async () => {
    const g = installControllable()
    render(<App />)
    await flush()
    await act(async () => {
      g.resolveEnumeration([CAMS.cam1, MICS.mic1])
      await Promise.resolve()
    })

    // 两次设备变更发起两个枚举
    act(() => g.emitDeviceChange())
    act(() => g.emitDeviceChange())
    // 新枚举先回（含 cam2）
    await act(async () => {
      g.resolveEnumerationAt(1, [CAMS.cam1, CAMS.cam2, MICS.mic1])
      await Promise.resolve()
    })
    expect(
      Array.from(cameraSelect().options).map((o) => o.value),
    ).toContain('cam2')

    // 导演选定新设备 cam2
    await act(async () => {
      fireEvent.change(cameraSelect(), { target: { value: 'cam2' } })
    })
    expect(cameraSelect().value).toBe('cam2')

    // 较早枚举迟到返回旧清单：选项与选择都不被覆盖
    await act(async () => {
      g.resolveEnumerationAt(0, [CAMS.cam1, MICS.mic1])
      await Promise.resolve()
    })
    expect(
      Array.from(cameraSelect().options).map((o) => o.value),
    ).toContain('cam2')
    expect(cameraSelect().value).toBe('cam2')
  })

  it('授权等待期间热插拔：下拉锁定并显示本次冻结设备（旧设备已离清单也显示“本次已锁定”）', async () => {
    const g = installControllable()
    render(<App />)
    await flush()
    await act(async () => {
      g.resolveEnumeration([CAMS.cam1, MICS.mic1])
      await Promise.resolve()
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
    })
    expect(g.pending).toHaveLength(1)
    expect(cameraSelect().disabled).toBe(true)
    expect(cameraSelect().value).toBe('cam1')

    // 授权未决期间设备变更：cam1/mic1 整体被新设备替换
    act(() => g.emitDeviceChange())
    await act(async () => {
      g.resolveEnumeration([CAMS.cam2, MICS.mic2])
      await Promise.resolve()
    })

    // 下拉值与可见文本仍是本次冻结的旧设备
    expect(cameraSelect().value).toBe('cam1')
    expect(micSelect().value).toBe('mic1')
    expect(cameraSelect().selectedOptions[0].textContent).toContain('摄像头 A')
    expect(micSelect().selectedOptions[0].textContent).toContain('麦克风 A')
    // 冻结设备已离开最新清单：补一个“本次已锁定”选项
    expect(cameraSelect().selectedOptions[0].textContent).toContain('本次已锁定')
    // 锁定设备身份行展示同一名称
    const locked = document.querySelector('[data-locked-devices]')
    expect(locked?.textContent).toContain('摄像头 摄像头 A')
    expect(locked?.textContent).toContain('麦克风 麦克风 A')

    // 取流约束仍是冻结设备
    expect(g.pending[0].constraints).toEqual({
      video: { deviceId: { exact: 'cam1' } },
      audio: { deviceId: { exact: 'mic1' } },
    })

    // 放行录制后展示依旧一致
    await act(async () => {
      g.grant()
      await Promise.resolve()
    })
    expect(cameraSelect().value).toBe('cam1')
    expect(cameraSelect().selectedOptions[0].textContent).toContain('摄像头 A')
  })

  it('所选设备在空闲时被拔除：明确提示下一条所用设备，停止后成片卡片显示冻结身份', async () => {
    const g = installControllable()
    render(<App />)
    await flush()
    await act(async () => {
      g.resolveEnumeration([CAMS.cam1, CAMS.cam2, MICS.mic1])
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.change(cameraSelect(), { target: { value: 'cam2' } })
    })

    // 拔除 cam2
    act(() => g.emitDeviceChange())
    await act(async () => {
      g.resolveEnumeration([CAMS.cam1, MICS.mic1])
      await Promise.resolve()
    })
    const notice = document.querySelector(
      '[data-device-notice="videoinput"]',
    )
    expect(notice?.textContent).toContain(CAMS.cam2.label)
    expect(notice?.textContent).toContain(CAMS.cam1.label)
    expect(notice?.textContent).toContain('下一条 take')
    expect(cameraSelect().value).toBe('cam1')

    // 用自动落到的 cam1 拍一条
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
    })
    await act(async () => {
      g.grant()
      await Promise.resolve()
    })
    const rec = FakeMediaRecorder.instances[0]
    // 录制中再拔掉 mic1：本次锁定显示 mic1，不漂移
    act(() => g.emitDeviceChange())
    await act(async () => {
      g.resolveEnumeration([CAMS.cam1, MICS.mic2])
      await Promise.resolve()
    })
    expect(micSelect().value).toBe('mic1')
    expect(micSelect().selectedOptions[0].textContent).toContain('麦克风 A')

    await act(async () => {
      rec.emitData(['take'])
      fireEvent.click(screen.getByRole('button', { name: '停止' }))
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })

    // 成片卡片显示冻结的实际设备：cam1 + mic1
    const cardDevices = document.querySelector('.take-devices')
    expect(cardDevices?.getAttribute('data-take-video-device')).toBe('cam1')
    expect(cardDevices?.getAttribute('data-take-audio-device')).toBe('mic1')
    expect(cardDevices?.textContent).toContain('摄像头 A')
    expect(cardDevices?.textContent).toContain('麦克风 A')

    // 停止后下一条麦克风选择已是 mic2，并有提示
    expect(micSelect().value).toBe('mic2')
    const audioNotice = document.querySelector(
      '[data-device-notice="audioinput"]',
    )
    expect(audioNotice?.textContent).toContain(MICS.mic2.label)
  })

  it('三种模式成片卡片各显示正确设备行；仅音频无摄像头行、仅视频无麦克风行', async () => {
    const g = installControllable()
    render(<App />)
    await flush()
    await act(async () => {
      g.resolveEnumeration([CAMS.cam1, MICS.mic1])
      await Promise.resolve()
    })

    const shoot = async (modeName: string) => {
      await act(async () => {
        fireEvent.click(screen.getByRole('radio', { name: new RegExp(modeName) }))
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
        g.grant()
        await Promise.resolve()
        await Promise.resolve()
      })
      const rec = FakeMediaRecorder.instances[
        FakeMediaRecorder.instances.length - 1
      ]
      expect(rec).toBeTruthy()
      await act(async () => {
        rec.emitData(['x'])
        fireEvent.click(screen.getByRole('button', { name: '停止' }))
        rec.emitStop()
        await Promise.resolve()
        await Promise.resolve()
      })
      // 排空 onSettled 枚举
      await act(async () => {
        if (g.pendingEnumCount() > 0) {
          g.resolveEnumeration([CAMS.cam1, MICS.mic1])
        }
        await Promise.resolve()
      })
    }

    await shoot('音视频')
    await shoot('仅视频')
    await shoot('仅音频')

    const cards = Array.from(document.querySelectorAll('.take-card'))
    expect(cards).toHaveLength(3)
    // 倒序渲染：最新（仅音频）在前
    const [audioCard, videoCard, avCard] = cards

    // 仅音频：无摄像头设备行，视频 id 属性为空串
    expect(audioCard.querySelectorAll('.take-device')).toHaveLength(1)
    expect(
      audioCard
        .querySelector('.take-devices')
        ?.getAttribute('data-take-video-device'),
    ).toBe('')
    expect(
      audioCard
        .querySelector('.take-devices')
        ?.getAttribute('data-take-audio-device'),
    ).toBe('mic1')
    expect(audioCard.textContent).toContain('麦克风 A')
    expect(audioCard.textContent).not.toContain('摄像头：')

    // 仅视频：无麦克风设备行
    expect(videoCard.querySelectorAll('.take-device')).toHaveLength(1)
    expect(
      videoCard
        .querySelector('.take-devices')
        ?.getAttribute('data-take-audio-device'),
    ).toBe('')
    expect(
      videoCard
        .querySelector('.take-devices')
        ?.getAttribute('data-take-video-device'),
    ).toBe('cam1')
    expect(videoCard.textContent).not.toContain('麦克风：')

    // 音视频：两条设备行
    expect(avCard.querySelectorAll('.take-device')).toHaveLength(2)
    expect(
      avCard
        .querySelector('.take-devices')
        ?.getAttribute('data-take-video-device'),
    ).toBe('cam1')
    expect(
      avCard
        .querySelector('.take-devices')
        ?.getAttribute('data-take-audio-device'),
    ).toBe('mic1')

    // 旧成片交付选择仍可切换
    const selectButtons = screen.getAllByRole('button', { name: '选为交付版' })
    await act(async () => {
      fireEvent.click(selectButtons[selectButtons.length - 1]) // 最早的 av
    })
    expect(
      (
        screen.getByRole('button', {
          name: '下载交付版',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false)
  }, 20000)

  it('取消等待授权后：设备解锁，迟到设备变更只影响待选清单，不影响任何成片', async () => {
    const g = installControllable()
    render(<App />)
    await flush()
    await act(async () => {
      g.resolveEnumeration([CAMS.cam1, MICS.mic1])
      await Promise.resolve()
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '取消本次开拍' }))
    })
    expect(cameraSelect().disabled).toBe(false)
    expect(document.querySelectorAll('.take-card')).toHaveLength(0)

    // 取消后设备变更正常刷新待选清单
    act(() => g.emitDeviceChange())
    await act(async () => {
      g.resolveEnumeration([CAMS.cam1, CAMS.cam2, MICS.mic1])
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(
        Array.from(cameraSelect().options).map((o) => o.value),
      ).toContain('cam2'),
    )
  })
})
