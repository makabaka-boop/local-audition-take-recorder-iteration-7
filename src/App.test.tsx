import { describe, expect, it, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from './App'
import { FakeMediaRecorder, FakeTrack } from './test/fakes'

/**
 * UI 层测试：下载按钮使用“当前所选交付版”；三种模式的切换/禁用、
 * 授权等待期间冻结、仅音频用 <audio> 回放、无麦克风时仅视频仍可成片下载。
 */

interface Pending {
  constraints?: MediaStreamConstraints
  resolve: (stream: MediaStream) => void
  reject: (err: unknown) => void
}

function installGlobals(opts?: {
  manualPermissions?: boolean
  missingKinds?: Array<'audio' | 'video'>
}) {
  const pending: Pending[] = []
  const missing = new Set(opts?.missingKinds ?? [])

  const tracksFor = (constraints?: MediaStreamConstraints): FakeTrack[] => {
    const tracks: FakeTrack[] = []
    if (constraints?.video !== false) {
      if (missing.has('video')) {
        throw new DOMException('no cam', 'NotFoundError')
      }
      tracks.push(new FakeTrack('video'))
    }
    if (constraints?.audio !== false) {
      if (missing.has('audio')) {
        throw new DOMException('no mic', 'NotFoundError')
      }
      tracks.push(new FakeTrack('audio'))
    }
    return tracks
  }

  const enumerateDevices = vi.fn(async () => [
    { deviceId: 'cam1', kind: 'videoinput', label: '摄像头 A', toJSON() {} },
    { deviceId: 'mic1', kind: 'audioinput', label: '麦克风 A', toJSON() {} },
  ])
  const getUserMedia = vi.fn((constraints?: MediaStreamConstraints) => {
    if (opts?.manualPermissions) {
      return new Promise<MediaStream>((resolve, reject) => {
        pending.push({ constraints, resolve, reject })
      })
    }
    try {
      const tracks = tracksFor(constraints)
      return Promise.resolve({
        getTracks: () => tracks,
      } as unknown as MediaStream)
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
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  })

  return {
    enumerateDevices,
    getUserMedia,
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

/** 录制一条成片并停止，返回该 take 的 recorder 替身 */
async function shootAndStop(modeLabel?: string) {
  if (modeLabel) {
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: new RegExp(modeLabel) }))
    })
  }
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
  })
  const rec = FakeMediaRecorder.instances[
    FakeMediaRecorder.instances.length - 1
  ]
  await act(async () => {
    rec.emitData(['take-data'])
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    rec.emitStop()
    await Promise.resolve()
    await Promise.resolve()
  })
  return rec
}

describe('下载交付版一致性', () => {
  let stubs: ReturnType<typeof vi.spyOn>[] = []

  // 用 beforeAll/afterAll 而非 beforeEach：RTL 的 afterEach 清理在本文件
  // afterEach 之后执行，卸载时仍需这些 jsdom 缺失方法的桩
  beforeAll(() => {
    stubs = [
      vi
        .spyOn(HTMLMediaElement.prototype, 'play')
        .mockImplementation(() => Promise.resolve()),
      vi
        .spyOn(HTMLMediaElement.prototype, 'pause')
        .mockImplementation(() => undefined),
      vi
        .spyOn(HTMLMediaElement.prototype, 'load')
        .mockImplementation(() => undefined),
    ]
  })

  afterAll(() => {
    stubs.forEach((s) => s.mockRestore())
  })

  beforeEach(() => {
    FakeMediaRecorder.reset()
    installGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('把 B 选为交付版后点击下载，下载链接指向 B 的对象 URL 而非列表首条 A', async () => {
    render(<App />)
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '开始 take' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )

    await shootAndStop() // take A
    await shootAndStop() // take B

    // 列表按时间倒序渲染：第一张卡片是最新的 B，第二张是 A
    const takeVideos = Array.from(
      document.querySelectorAll<HTMLVideoElement>('video.take-video'),
    )
    expect(takeVideos).toHaveLength(2)
    const urlB = takeVideos[0].src
    const urlA = takeVideos[1].src
    expect(urlB).not.toBe(urlA)

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: '选为交付版' })[0])
    })

    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    const created: HTMLAnchorElement[] = []
    const appendSpy = vi
      .spyOn(document.body, 'appendChild')
      .mockImplementation((node) => {
        created.push(node as HTMLAnchorElement)
        return node as never
      })

    fireEvent.click(screen.getByRole('button', { name: '下载交付版' }))

    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(created).toHaveLength(1)
    // 下载目标必须是当前标记的交付版 B，而不是列表首条 A
    expect(created[0].href).toBe(urlB)
    expect(created[0].href).not.toBe(urlA)

    clickSpy.mockRestore()
    appendSpy.mockRestore()
  })
})

describe('模式切换与 MIME 能力隔离（UI）', () => {
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

  it('默认音视频；三模式单选可在空闲切换，录制相关控件在 starting 冻结', async () => {
    const g = installGlobals({ manualPermissions: true })
    render(<App />)
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '开始 take' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )

    const avRadio = screen.getByRole('radio', { name: /音视频/ })
    const videoRadio = screen.getByRole('radio', { name: /仅视频/ })
    const audioRadio = screen.getByRole('radio', { name: /仅音频/ })
    expect((avRadio as HTMLInputElement).checked).toBe(true)

    fireEvent.click(videoRadio)
    expect((videoRadio as HTMLInputElement).checked).toBe(true)
    fireEvent.click(audioRadio)
    expect((audioRadio as HTMLInputElement).checked).toBe(true)
    fireEvent.click(avRadio)
    expect((avRadio as HTMLInputElement).checked).toBe(true)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
    })
    // 已进入 starting：模式/设备/开拍按钮全部冻结
    expect(
      (
        screen.getByRole('button', { name: '开始 take' }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    expect((avRadio as HTMLInputElement).disabled).toBe(true)
    expect((videoRadio as HTMLInputElement).disabled).toBe(true)
    expect((audioRadio as HTMLInputElement).disabled).toBe(true)

    // 授权等待期间点击无效
    fireEvent.click(audioRadio)
    fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
    expect(g.getUserMedia).toHaveBeenCalledTimes(1)

    await act(async () => {
      g.grant()
      await Promise.resolve()
    })
    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    expect(rec.mimeType).toBe('video/webm;codecs=vp9,opus')

    await act(async () => {
      rec.emitData(['frozen-ui'])
      fireEvent.click(screen.getByRole('button', { name: '停止' }))
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })
    // 回 idle 解锁
    await waitFor(() => expect((avRadio as HTMLInputElement).disabled).toBe(false))
  })

  it('纯 audio/webm 环境：两个视频模式禁用并标注不可用，仅音频成片用 <audio> 回放', async () => {
    // 能力在挂载时探测：先布置环境再渲染
    FakeMediaRecorder.supported = ['audio/webm']
    installGlobals()
    render(<App />)
    await waitFor(() =>
      expect(
        (screen.getByRole('radio', { name: /仅音频/ }) as HTMLInputElement)
          .disabled,
      ).toBe(false),
    )

    const avRadio = screen.getByRole('radio', { name: /音视频/ })
    const videoRadio = screen.getByRole('radio', { name: /仅视频/ })
    const audioRadio = screen.getByRole('radio', { name: /仅音频/ })
    expect((avRadio as HTMLInputElement).disabled).toBe(true)
    expect((videoRadio as HTMLInputElement).disabled).toBe(true)
    expect((audioRadio as HTMLInputElement).disabled).toBe(false)
    expect(
      (screen.getByRole('button', { name: '开始 take' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)

    fireEvent.click(audioRadio)
    expect((audioRadio as HTMLInputElement).checked).toBe(true)
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', { name: '开始 take' }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    )
    expect(screen.getByText('audio/webm')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
    })
    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    expect(rec.mimeType).toBe('audio/webm')
    await act(async () => {
      rec.emitData(['sound'])
      fireEvent.click(screen.getByRole('button', { name: '停止' }))
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })

    // 仅音频成片以 <audio> 回放，页面没有成片 <video>
    const audioEl = document.querySelector('audio.take-audio')
    expect(audioEl).toBeTruthy()
    expect(document.querySelectorAll('video.take-video')).toHaveLength(0)
    expect((audioEl as HTMLAudioElement).src).toContain('blob:')
  })

  it('麦克风不可用时仅视频仍能成片、回放并下载所选 take', async () => {
    installGlobals({ missingKinds: ['audio'] })
    render(<App />)
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '开始 take' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )

    fireEvent.click(screen.getByRole('radio', { name: /仅视频/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
    })
    // 无错误提示、无授权弹窗残留：audio:false 直接成功
    expect(screen.queryByRole('alert')).toBeNull()

    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    expect(rec.mimeType).toBe('video/webm;codecs=vp9')
    await act(async () => {
      rec.emitData(['vision'])
      fireEvent.click(screen.getByRole('button', { name: '停止' }))
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })

    const takeVideo = document.querySelector(
      'video.take-video',
    ) as HTMLVideoElement
    expect(takeVideo).toBeTruthy()
    const takeUrl = takeVideo.src

    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    const created: HTMLAnchorElement[] = []
    const appendSpy = vi
      .spyOn(document.body, 'appendChild')
      .mockImplementation((node) => {
        created.push(node as HTMLAnchorElement)
        return node as never
      })

    fireEvent.click(screen.getByRole('button', { name: '下载交付版' }))
    expect(created).toHaveLength(1)
    expect(created[0].href).toBe(takeUrl)

    clickSpy.mockRestore()
    appendSpy.mockRestore()
  })
})

describe('授权未决时取消（UI）', () => {
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

  it('授权弹窗未决时停止入口可用（显示“取消”），取消后可靠回到可再次录制状态', async () => {
    const g = installGlobals({ manualPermissions: true })
    render(<App />)
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '开始 take' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )

    fireEvent.click(screen.getByRole('radio', { name: /仅音频/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
    })
    expect(g.pending).toHaveLength(1)

    // 停止入口在授权未决时可用并呈现“取消”
    const cancelBtn = screen.getByRole('button', { name: '取消本次开拍' })
    expect((cancelBtn as HTMLButtonElement).disabled).toBe(false)

    await act(async () => {
      fireEvent.click(cancelBtn)
    })

    // 无成片、无错误、状态回空闲
    expect(screen.queryByRole('alert')).toBeNull()
    expect(
      document.querySelectorAll('video.take-video, audio.take-audio'),
    ).toHaveLength(0)
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '开始 take' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )
    // 模式切换解锁
    expect(
      (screen.getByRole('radio', { name: /音视频/ }) as HTMLInputElement)
        .disabled,
    ).toBe(false)

    // 迟到的授权结果被吞掉；随后可正常再录一条
    await act(async () => {
      g.grant()
      await Promise.resolve()
    })
    expect(FakeMediaRecorder.instances).toHaveLength(0)

    fireEvent.click(screen.getByRole('radio', { name: /音视频/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
      g.grant()
      await Promise.resolve()
    })
    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    expect(rec.mimeType).toBe('video/webm;codecs=vp9,opus')
    await act(async () => {
      rec.emitData(['retry'])
      fireEvent.click(screen.getByRole('button', { name: '停止' }))
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.querySelectorAll('video.take-video')).toHaveLength(1)
  })
})
