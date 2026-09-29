import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from './App'
import { FakeMediaRecorder, FakeTrack } from './test/fakes'

/**
 * 开拍预检页面验收：预检到正式录制必须交接同一条 MediaStream；
 * 覆盖可控权限 Promise、假轨道、设备变更、取消/拔出/启动失败等交错时序。
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

function installApi() {
  const pending: Pending[] = []
  const grantedTracks: FakeTrack[] = []
  const pendingEnums: Array<(devices: DeviceDef[]) => void> = []
  const deviceChangeListeners: Array<() => void> = []
  let enumCalls = 0

  const tracksFor = (constraints?: MediaStreamConstraints): FakeTrack[] => {
    const tracks: FakeTrack[] = []
    if (constraints?.video !== false) tracks.push(new FakeTrack('video'))
    if (constraints?.audio !== false) tracks.push(new FakeTrack('audio'))
    return tracks
  }

  const getUserMedia = vi.fn((constraints?: MediaStreamConstraints) => {
    return new Promise<MediaStream>((resolve, reject) => {
      pending.push({ constraints, resolve, reject })
    })
  })
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

  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: {
      getUserMedia,
      enumerateDevices,
      addEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === 'devicechange') deviceChangeListeners.push(listener)
      }),
      removeEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === 'devicechange') {
          const index = deviceChangeListeners.indexOf(listener)
          if (index >= 0) deviceChangeListeners.splice(index, 1)
        }
      }),
    },
  })

  return {
    getUserMedia,
    grant: () => {
      const item = pending.shift()
      if (!item) throw new Error('没有等待中的权限请求')
      const tracks = tracksFor(item.constraints)
      grantedTracks.push(...tracks)
      item.resolve({ getTracks: () => tracks } as unknown as MediaStream)
    },
    deny: (error = new DOMException('denied', 'NotAllowedError')) => {
      pending.shift()?.reject(error)
    },
    tracks: grantedTracks,
    resolveEnumeration: (devices: DeviceDef[]) => {
      pendingEnums.shift()?.(devices)
    },
    emitDeviceChange: () => {
      for (const listener of [...deviceChangeListeners]) listener()
    },
    pendingEnumCount: () => pendingEnums.length,
    enumCalls: () => enumCalls,
  }
}

const DEVICES = [
  { deviceId: 'cam1', kind: 'videoinput', label: '摄像头 A' },
  { deviceId: 'cam2', kind: 'videoinput', label: '摄像头 B' },
  { deviceId: 'mic1', kind: 'audioinput', label: '麦克风 A' },
  { deviceId: 'mic2', kind: 'audioinput', label: '麦克风 B' },
]

async function flush(times = 4) {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve()
  })
}

async function resolveInitialDevices(api: ReturnType<typeof installApi>) {
  await act(async () => {
    api.resolveEnumeration(DEVICES)
    await Promise.resolve()
  })
}

async function grantPreflight(api: ReturnType<typeof installApi>) {
  await act(async () => {
    api.grant()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function confirmStart() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '确认开拍' }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('开拍预检页面', () => {
  beforeAll(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() =>
      Promise.resolve(),
    )
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
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

  it('预检显示实时预览和输入反馈，确认开拍把同一 MediaStream 交给录制器', async () => {
    const api = installApi()
    render(<App />)
    await flush()
    await resolveInitialDevices(api)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '申请预检' }))
    })
    expect(screen.queryByText('预检就绪')).toBeNull()
    expect(
      (screen.getByRole('button', { name: '确认开拍' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)

    await grantPreflight(api)
    expect(screen.getByText('预检就绪')).toBeTruthy()
    expect(
      document.querySelector(
        '[data-track-kind="video"][data-track-state="live"]',
      ),
    ).toBeTruthy()
    expect(
      document.querySelector(
        '[data-track-kind="audio"][data-track-state="live"]',
      ),
    ).toBeTruthy()
    const previewVideo = document.querySelector('video.preview') as HTMLVideoElement
    const previewStream = previewVideo.srcObject as MediaStream
    expect(previewStream).toBeTruthy()
    expect(api.getUserMedia).toHaveBeenCalledTimes(1)
    expect(FakeMediaRecorder.instances).toHaveLength(0)

    await confirmStart()
    expect(screen.getByText('录制中')).toBeTruthy()
    expect(api.getUserMedia).toHaveBeenCalledTimes(1)
    const recorder = FakeMediaRecorder.instances[0]
    expect(recorder).toBeTruthy()
    expect(recorder.stream).toBe(previewStream)
    expect(previewVideo.srcObject).toBe(previewStream)

    await act(async () => {
      recorder.emitData(['same-stream-page'])
      fireEvent.click(screen.getByRole('button', { name: '停止' }))
      recorder.emitStop()
      await Promise.resolve()
    })
    expect(document.querySelectorAll('.take-card')).toHaveLength(1)
  })

  it('权限未决、就绪期间修改模式或设备被锁定；必须取消旧预检后才能重新申请', async () => {
    const api = installApi()
    render(<App />)
    await flush()
    await resolveInitialDevices(api)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '申请预检' }))
    })
    const avRadio = screen.getByRole('radio', { name: /音视频/ }) as HTMLInputElement
    const videoOnlyRadio = screen.getByRole('radio', { name: /仅视频/ }) as HTMLInputElement
    const cameraSelect = document.querySelector(
      'select[data-device-kind="videoinput"]',
    ) as HTMLSelectElement
    expect(avRadio.disabled).toBe(true)
    expect(videoOnlyRadio.disabled).toBe(true)
    expect(cameraSelect.disabled).toBe(true)

    fireEvent.click(videoOnlyRadio)
    fireEvent.change(cameraSelect, { target: { value: 'cam2' } })
    expect(avRadio.checked).toBe(true)
    expect(cameraSelect.value).toBe('cam1')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '取消预检' }))
    })
    expect(avRadio.disabled).toBe(false)
    expect(cameraSelect.disabled).toBe(false)

    await act(async () => {
      fireEvent.click(videoOnlyRadio)
      fireEvent.change(cameraSelect, { target: { value: 'cam2' } })
      fireEvent.click(screen.getByRole('button', { name: '申请预检' }))
    })
    await grantPreflight(api)
    expect(api.getUserMedia).toHaveBeenCalledTimes(2)
    expect(api.getUserMedia.mock.calls[1][0]).toEqual({
      video: { deviceId: { exact: 'cam2' } },
      audio: false,
    })
  })

  it('权限晚到：取消预检后迟到 grant 的旧流不交接，重新预检使用新会话', async () => {
    const api = installApi()
    render(<App />)
    await flush()
    await resolveInitialDevices(api)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '申请预检' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '取消预检' }))
    })
    await grantPreflight(api)
    expect(FakeMediaRecorder.instances).toHaveLength(0)
    expect(api.tracks.slice(0, 2).map((track) => track.readyState)).toEqual([
      'ended',
      'ended',
    ])
    expect(screen.queryByText('录制中')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '申请预检' }))
    })
    await grantPreflight(api)
    await confirmStart()
    expect(api.getUserMedia).toHaveBeenCalledTimes(2)
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    expect(screen.getByText('录制中')).toBeTruthy()
  })

  it('预检期间设备拔出：状态回空闲、轨道释放、不产生 take，也不显示录制中', async () => {
    const api = installApi()
    render(<App />)
    await flush()
    await resolveInitialDevices(api)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '申请预检' }))
    })
    await grantPreflight(api)
    const [videoTrack, audioTrack] = api.tracks

    act(() => videoTrack.emitEnded())
    expect(screen.getByText('空闲')).toBeTruthy()
    expect(screen.queryByText('录制中')).toBeNull()
    expect(videoTrack.readyState).toBe('ended')
    expect(audioTrack.readyState).toBe('ended')
    expect(document.querySelectorAll('.take-card')).toHaveLength(0)
    expect(screen.getByRole('alert').textContent).toContain('开拍前断开')
  })

  it('预检期间设备变更只影响下一条：本次仍锁定旧设备；取消重申请才用新设备', async () => {
    const api = installApi()
    render(<App />)
    await flush()
    await resolveInitialDevices(api)
    const cameraSelect = () =>
      document.querySelector(
        'select[data-device-kind="videoinput"]',
      ) as HTMLSelectElement
    const micSelect = () =>
      document.querySelector(
        'select[data-device-kind="audioinput"]',
      ) as HTMLSelectElement

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '申请预检' }))
    })
    await grantPreflight(api)
    act(() => api.emitDeviceChange())
    await act(async () => {
      api.resolveEnumeration([
        { deviceId: 'cam2', kind: 'videoinput', label: '摄像头 B' },
        { deviceId: 'mic2', kind: 'audioinput', label: '麦克风 B' },
      ])
      await Promise.resolve()
    })

    expect(cameraSelect().value).toBe('cam1')
    expect(micSelect().value).toBe('mic1')
    expect(cameraSelect().selectedOptions[0].textContent).toContain('本次已锁定')
    expect(api.getUserMedia).toHaveBeenCalledTimes(1)
    expect(api.getUserMedia.mock.calls[0][0]).toEqual({
      video: { deviceId: { exact: 'cam1' } },
      audio: { deviceId: { exact: 'mic1' } },
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '取消预检' }))
    })
    await waitFor(() => expect(cameraSelect().disabled).toBe(false))
    expect(cameraSelect().value).toBe('cam2')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '申请预检' }))
    })
    expect(api.getUserMedia.mock.calls[1][0]).toEqual({
      video: { deviceId: { exact: 'cam2' } },
      audio: { deviceId: { exact: 'mic2' } },
    })
  })

  it('录制器启动失败：释放预检流、回空闲并保留历史 take', async () => {
    const api = installApi()
    render(<App />)
    await flush()
    await resolveInitialDevices(api)

    // 先录一条历史 take
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '申请预检' }))
    })
    await grantPreflight(api)
    await confirmStart()
    const first = FakeMediaRecorder.instances[0]
    await act(async () => {
      first.emitData(['history'])
      fireEvent.click(screen.getByRole('button', { name: '停止' }))
      first.emitStop()
      await Promise.resolve()
    })
    expect(document.querySelectorAll('.take-card')).toHaveLength(1)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '申请预检' }))
    })
    await grantPreflight(api)
    const failedTracks = api.tracks.slice(2)
    FakeMediaRecorder.startThrows = new Error('start failed')
    await confirmStart()
    FakeMediaRecorder.startThrows = null

    expect(screen.getByText('空闲')).toBeTruthy()
    expect(screen.queryByText('录制中')).toBeNull()
    expect(failedTracks.every((track) => track.readyState === 'ended')).toBe(true)
    expect(document.querySelectorAll('.take-card')).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toContain('录制启动失败')
  })
})
