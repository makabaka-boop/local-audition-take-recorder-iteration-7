import {
  describe,
  expect,
  it,
  beforeEach,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from './App'
import { FakeMediaRecorder, FakeTrack } from './test/fakes'

/**
 * 瞬间标记页面测试：
 * - 录制中打标、实时列表与暂停边界提示；同毫秒按创建次序展示
 * - 停止后标记冻结在 take 卡片，点击标记把播放器 currentTime 定位到有效时间
 * - 空 Blob 不生成带标记 take；设备中断后重录不串标记
 */

interface Pending {
  constraints?: MediaStreamConstraints
  resolve: (stream: MediaStream) => void
  reject: (err: unknown) => void
}

function installGlobals(opts?: { manualPermissions?: boolean }) {
  const pending: Pending[] = []
  const tracks: FakeTrack[] = []
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
    if (opts?.manualPermissions) {
      return new Promise<MediaStream>((resolve, reject) => {
        pending.push({ constraints, resolve, reject })
      })
    }
    const set = tracksFor(constraints)
    tracks.push(...set)
    return Promise.resolve({
      getTracks: () => set,
    } as unknown as MediaStream)
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
    tracks,
    grant: () => {
      const item = pending.shift()
      if (!item) throw new Error('无等待中的授权')
      const set = tracksFor(item.constraints)
      tracks.push(...set)
      item.resolve({ getTracks: () => set } as unknown as MediaStream)
    },
  }
}

async function flushMicrotasks(times = 6) {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve()
  })
}

function markerInput(): HTMLInputElement {
  return screen.getByLabelText('瞬间标记标签')
}

function addMarkerByUi(label: string) {
  fireEvent.change(markerInput(), { target: { value: label } })
  fireEvent.click(screen.getByRole('button', { name: '打标记' }))
}

async function clickStart(g?: ReturnType<typeof installGlobals>) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
    if (g) {
      g.grant()
      await Promise.resolve()
    }
    await Promise.resolve()
    await Promise.resolve()
  })
  return FakeMediaRecorder.instances[
    FakeMediaRecorder.instances.length - 1
  ]
}

async function stopRecorder(rec: FakeMediaRecorder, empty = false) {
  await act(async () => {
    if (empty) rec.emitEmptyData()
    else rec.emitData(['take-data'])
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    rec.emitStop()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('瞬间标记页面', () => {
  let playSpy: ReturnType<typeof vi.spyOn>
  let pauseSpy: ReturnType<typeof vi.spyOn>
  let loadSpy: ReturnType<typeof vi.spyOn>

  beforeAll(() => {
    playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockImplementation(() => Promise.resolve())
    pauseSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'pause')
      .mockImplementation(() => undefined)
    loadSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'load')
      .mockImplementation(() => undefined)
  })

  afterAll(() => {
    playSpy.mockRestore()
    pauseSpy.mockRestore()
    loadSpy.mockRestore()
  })

  beforeEach(() => {
    FakeMediaRecorder.reset()
    vi.useFakeTimers()
    installGlobals()
  })

  afterEach(() => {
    // 个别用例中途切换到真实定时器：统一回到真实定时器并恢复全局桩
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('录制中打标：暂停时段不漂移、同毫秒按次序展示，停止后点击标记与播放器时间同步', async () => {
    render(<App />)
    await flushMicrotasks()
    const rec = await clickStart()
    expect(markerInput().disabled).toBe(false)

    act(() => vi.advanceTimersByTime(1000))
    addMarkerByUi('第一次笑')

    // 暂停：打标入口禁用，提示明确；暂停 5s 绝不能推进标记时间
    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    expect(markerInput().disabled).toBe(true)
    expect(screen.getByText('已暂停，不能打标记；继续录制后再标记。')).toBeTruthy()
    act(() => vi.advanceTimersByTime(5000))

    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    act(() => vi.advanceTimersByTime(1500))
    // 同一毫秒连续两条：创建次序必须保留
    addMarkerByUi('同帧-甲')
    addMarkerByUi('同帧-乙')

    const liveChips = Array.from(
      document.querySelectorAll<HTMLElement>('.marker-live-chip'),
    )
    expect(liveChips.map((el) => el.dataset.liveMarkerTime)).toEqual([
      '1000',
      '2500',
      '2500',
    ])
    expect(
      liveChips.map((el) => el.querySelector('.marker-label')?.textContent),
    ).toEqual(['第一次笑', '同帧-甲', '同帧-乙'])

    await stopRecorder(rec)

    // 停止后录制面板不再展示实时标记，标记冻结在成片卡片
    expect(document.querySelectorAll('.marker-live-chip')).toHaveLength(0)
    const cards = Array.from(document.querySelectorAll('.take-card'))
    expect(cards).toHaveLength(1)
    const chips = Array.from(
      cards[0].querySelectorAll<HTMLButtonElement>('.marker-chip'),
    )
    expect(chips.map((el) => el.dataset.markerTime)).toEqual([
      '1000',
      '2500',
      '2500',
    ])
    expect(chips.map((el) => el.dataset.markerOrder)).toEqual(['0', '1', '2'])

    const video = document.querySelector('video.take-video') as HTMLVideoElement
    expect(video).toBeTruthy()
    // 预览播放也会计入 playSpy：从点击标记前的基线开始统计
    const playCallsBeforeMarkers = playSpy.mock.calls.length

    fireEvent.click(chips[0])
    expect(video.currentTime).toBeCloseTo(1.0, 5)

    fireEvent.click(chips[1])
    expect(video.currentTime).toBeCloseTo(2.5, 5)

    // 同毫秒第二条跳到同一播放器时间，次序仍是甲在前、乙在后
    fireEvent.click(chips[2])
    expect(video.currentTime).toBeCloseTo(2.5, 5)
    expect(playSpy.mock.calls.length - playCallsBeforeMarkers).toBe(3)
  })

  it('idle / starting / stopping 均明确不可标记，入口禁用且不产生标记', async () => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    const g = installGlobals({ manualPermissions: true })
    render(<App />)
    await waitFor(() => expect(markerInput().disabled).toBe(true))
    expect(
      screen.getByText('当前没有正在录制的 take，开始录制后才可打标记。'),
    ).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
    })
    expect(markerInput().disabled).toBe(true)
    expect(
      screen.getByText('正在等待设备授权，授权后开始录制才可打标记。'),
    ).toBeTruthy()

    const rec = await clickStart(g)

    act(() => rec.emitData(['d']))
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(markerInput().disabled).toBe(true)
    expect(
      screen.getByText('正在收尾停止，标记已随本 take 冻结。'),
    ).toBeTruthy()

    await act(async () => {
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(markerInput().disabled).toBe(true)
    expect(document.querySelectorAll('.marker-chip')).toHaveLength(0)
  })

  it('空标签立即给出错误提示，不产生标记', async () => {
    render(<App />)
    await flushMicrotasks()
    await clickStart()

    fireEvent.change(markerInput(), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: '打标记' }))
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('标记内容不能为空')
    expect(document.querySelectorAll('.marker-live-chip')).toHaveLength(0)
    expect(markerInput().value).toBe('   ')
  })

  it('空 Blob：不生成 take，实时标记不落任何成片；重录后的 take 只带新标记', async () => {
    render(<App />)
    await flushMicrotasks()
    const emptyRec = await clickStart()
    addMarkerByUi('空片里的标记')
    await stopRecorder(emptyRec, true)

    expect(document.querySelectorAll('.take-card')).toHaveLength(0)
    expect(screen.getByRole('alert').textContent).toContain('未采集到任何数据')
    expect(document.querySelectorAll('.marker-live-chip')).toHaveLength(0)

    const retryRec = await clickStart()
    act(() => vi.advanceTimersByTime(300))
    addMarkerByUi('重录标记')
    await stopRecorder(retryRec)

    const cards = Array.from(document.querySelectorAll('.take-card'))
    expect(cards).toHaveLength(1)
    const chips = cards[0].querySelectorAll('.marker-chip')
    expect(chips).toHaveLength(1)
    expect(chips[0].querySelector('.marker-label')?.textContent).toBe('重录标记')
    expect(chips[0].getAttribute('data-marker-time')).toBe('300')
  })

  it('设备中断成片后重录：两个 take 各自的标记只定位各自播放器，不串扰', async () => {
    render(<App />)
    await flushMicrotasks()

    const rec1 = await clickStart()
    act(() => vi.advanceTimersByTime(800))
    addMarkerByUi('中断瞬间')
    act(() => {
      rec1.emitData(['before-interrupt'])
      rec1.emitError({ name: 'UnknownError', message: 'device gone' })
    })
    expect(markerInput().disabled).toBe(true)
    await act(async () => {
      rec1.emitData(['tail'])
      rec1.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })

    const rec2 = await clickStart()
    act(() => vi.advanceTimersByTime(200))
    addMarkerByUi('重录瞬间')
    await stopRecorder(rec2)

    // 列表倒序：第一张是重录 take，第二张是中断 take
    const cards = Array.from(document.querySelectorAll('.take-card'))
    expect(cards).toHaveLength(2)
    const newestChips = cards[0].querySelectorAll<HTMLButtonElement>('.marker-chip')
    const interruptedChips = cards[1].querySelectorAll<HTMLButtonElement>(
      '.marker-chip',
    )
    expect(newestChips).toHaveLength(1)
    expect(interruptedChips).toHaveLength(1)
    expect(newestChips[0].querySelector('.marker-label')?.textContent).toBe(
      '重录瞬间',
    )
    expect(
      interruptedChips[0].querySelector('.marker-label')?.textContent,
    ).toBe('中断瞬间')
    expect(cards[1].textContent).toContain('设备中断')

    const videos = Array.from(
      document.querySelectorAll<HTMLVideoElement>('video.take-video'),
    )
    fireEvent.click(newestChips[0])
    expect(videos[0].currentTime).toBeCloseTo(0.2, 5)

    fireEvent.click(interruptedChips[0])
    expect(videos[1].currentTime).toBeCloseTo(0.8, 5)

    // 旧 take 播放器绝不能被新 take 的标记定位
    expect(videos[0].currentTime).toBeCloseTo(0.2, 5)
    expect(videos[1].currentTime).toBeCloseTo(0.8, 5)
  })
})
