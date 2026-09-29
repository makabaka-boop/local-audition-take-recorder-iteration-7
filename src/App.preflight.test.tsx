import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from './App'
import { FakeMediaRecorder, FakeTrack } from './test/fakes'
import type { MediaStreamLike } from './recorder/CaptureRecorder'

/**
 * 预检到正式录制的页面验收：真实交互中先取得唯一一条 MediaStream 做预览，
 * 确认后把同一条流交给 MediaRecorder，不再次请求设备；取消后必须重新申请。
 */

interface Pending {
  constraints?: MediaStreamConstraints
  resolve: (stream: MediaStream) => void
  reject: (err: unknown) => void
}

function installGlobals() {
  const pending: Pending[] = []
  const sessions: Array<{ stream: MediaStreamLike; tracks: FakeTrack[] }> = []
  const calls: MediaStreamConstraints[] = []
  const tracksFor = (constraints?: MediaStreamConstraints): FakeTrack[] => {
    const tracks: FakeTrack[] = []
    if (constraints?.video !== false) tracks.push(new FakeTrack('video'))
    if (constraints?.audio !== false) tracks.push(new FakeTrack('audio'))
    return tracks
  }

  const enumerateDevices = vi.fn(async () => [
    { deviceId: 'cam1', kind: 'videoinput', label: '摄像头 A', toJSON() {} },
    { deviceId: 'mic1', kind: 'audioinput', label: '麦克风 A', toJSON() {} },
  ])
  const getUserMedia = vi.fn((constraints?: MediaStreamConstraints) => {
    calls.push(constraints ?? {})
    return new Promise<MediaStream>((resolve, reject) => {
      pending.push({
        constraints,
        resolve: (stream) => {
          sessions.push({
            stream,
            tracks: (stream as unknown as { getTracks(): FakeTrack[] }).getTracks(),
          })
          resolve(stream)
        },
        reject,
      })
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
    calls,
    sessions,
    grant: () => {
      const item = pending.shift()
      if (!item) throw new Error('无等待中的授权')
      const tracks = tracksFor(item.constraints)
      item.resolve({ getTracks: () => tracks } as unknown as MediaStream)
    },
    deny: () => {
      pending
        .shift()
        ?.reject(new DOMException('denied', 'NotAllowedError'))
    },
  }
}

describe('开拍预检页面交接', () => {
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

  afterEach(() => {
    vi.unstubAllGlobals()
    FakeMediaRecorder.reset()
  })

  it('预检显示实时画面/输入反馈；确认开拍把同一条流交给录制器且只请求一次设备', async () => {
    const g = installGlobals()
    render(<App />)
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '检查设备' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '检查设备' }))
    })
    expect(g.pending).toHaveLength(1)
    expect(screen.getByText('正在请求设备…')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: '确认开拍' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)

    await act(async () => {
      g.grant()
      await Promise.resolve()
      await Promise.resolve()
    })

    const previewVideo = document.querySelector(
      'video.preview',
    ) as HTMLVideoElement
    expect(previewVideo).toBeTruthy()
    expect(previewVideo.srcObject).toBe(g.sessions[0].stream as MediaStream)
    expect(document.querySelector('[data-audio-meter]')).toBeTruthy()
    expect(screen.getByText('麦克风已接通')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: '确认开拍' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false)
    expect(FakeMediaRecorder.instances).toHaveLength(0)
    expect(document.querySelectorAll('.take-card')).toHaveLength(0)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认开拍' }))
    })

    expect(g.calls).toHaveLength(1)
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    expect(FakeMediaRecorder.streams[0]).toBe(g.sessions[0].stream)
    const activeVideo = document.querySelector(
      'video.preview',
    ) as HTMLVideoElement
    expect(activeVideo.srcObject).toBe(g.sessions[0].stream as MediaStream)
    expect(screen.getByText('录制中')).toBeTruthy()

    const rec = FakeMediaRecorder.instances[0]
    await act(async () => {
      rec.emitData(['preflight-hand-off'])
      fireEvent.click(screen.getByRole('button', { name: '停止' }))
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.querySelectorAll('.take-card')).toHaveLength(1)
  })

  it('预检期间模式和设备锁定；明确取消后重新检查才再次请求设备', async () => {
    const g = installGlobals()
    render(<App />)
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '检查设备' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )

    fireEvent.click(screen.getByRole('radio', { name: /仅视频/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '检查设备' }))
      g.grant()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByText('预检中')).toBeTruthy()
    expect(
      (screen.getByRole('radio', { name: /音视频/ }) as HTMLInputElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('radio', { name: /仅视频/ }) as HTMLInputElement).disabled,
    ).toBe(true)
    expect(
      (document.querySelector('select[data-device-kind="videoinput"]') as HTMLSelectElement)
        .disabled,
    ).toBe(true)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '取消预检' }))
    })
    expect(g.sessions[0].tracks.every((track) => track.readyState === 'ended')).toBe(true)
    expect(
      (screen.getByRole('radio', { name: /仅视频/ }) as HTMLInputElement).disabled,
    ).toBe(false)
    expect(
      (document.querySelector('select[data-device-kind="videoinput"]') as HTMLSelectElement)
        .disabled,
    ).toBe(false)
    expect(FakeMediaRecorder.instances).toHaveLength(0)
    expect(document.querySelectorAll('.take-card')).toHaveLength(0)

    fireEvent.click(screen.getByRole('radio', { name: /仅音频/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '检查设备' }))
      g.grant()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(g.calls).toHaveLength(2)
    expect(g.calls[1]).toEqual({ video: false, audio: { deviceId: { exact: 'mic1' } } })
    expect(screen.getByText('仅音频预检')).toBeTruthy()
    expect(document.querySelector('[data-audio-preview]')).toBeTruthy()
    expect(FakeMediaRecorder.instances).toHaveLength(0)
  })
})
