import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  CaptureRecorder,
  MIME_CANDIDATES,
  MODE_MIME_CANDIDATES,
  STOP_FINALIZE_GRACE_MS,
  pickSupportedMimeType,
  type CaptureMode,
  type MediaRecorderLikeCtor,
  type MediaStreamLike,
  type RecorderDeps,
  type Take,
} from '../recorder/CaptureRecorder'
import {
  expectedConstraints,
  FakeMediaRecorder,
  FakeTrack,
} from '../test/fakes'
import { makeHarness, readBlob, type Harness } from '../test/harness'

beforeEach(() => {
  FakeMediaRecorder.reset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function startTake(h: Harness) {
  h.recorder.start()
  await h.flush()
  expect(h.recorder.getStatus()).toBe('recording')
  return h.lastRecorder()
}

describe('编码探测顺序', () => {
  it('按 vp9,opus → vp8,opus → webm 顺序选首个受支持项', () => {
    FakeMediaRecorder.supported = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ]
    const h = makeHarness()
    expect(h.recorder.getSupportedMimeType()).toBe(MIME_CANDIDATES[0])
  })

  it('vp9 不支持时回退到 vp8,opus', () => {
    FakeMediaRecorder.supported = [
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ]
    const h = makeHarness()
    expect(h.recorder.getSupportedMimeType()).toBe(MIME_CANDIDATES[1])
  })

  it('只有裸 webm 受支持时使用 video/webm', () => {
    FakeMediaRecorder.supported = ['video/webm']
    const h = makeHarness()
    expect(h.recorder.getSupportedMimeType()).toBe('video/webm')
  })

  it('全部不可用返回 null', () => {
    FakeMediaRecorder.supported = []
    const h = makeHarness()
    expect(h.recorder.getSupportedMimeType()).toBeNull()
  })

  it('isTypeSupported 抛异常时按不支持继续探测', () => {
    const throwing = {
      isTypeSupported: () => {
        throw new Error('bad mime')
      },
    } as unknown as MediaRecorderLikeCtor
    expect(pickSupportedMimeType(throwing)).toBeNull()
  })
})

describe('正常生命周期', () => {
  it('start → 到达 chunks → 用户 stop 时合并为单个成片', async () => {
    const h = makeHarness()
    const rec = await startTake(h)

    h.clock.now = 2000
    rec.emitData(['a'])
    rec.emitData(['b'])
    rec.emitEmptyData() // 空 chunk 必须被丢弃
    rec.emitData(['c'])
    h.clock.now = 3500

    h.recorder.stop()
    expect(h.recorder.getStatus()).toBe('stopping')
    rec.emitStop()

    expect(h.takes).toHaveLength(1)
    const take = h.takes[0]
    expect(take.reason).toBe('user')
    expect(take.durationMs).toBe(2500)
    // 非空 chunk 按到达顺序合并（空 chunk 未计入）
    const text = await readBlob(take.blob)
    expect(text).toBe('a\nb\nc\n')
    expect(h.urls.has(take.url)).toBe(true)
    expect(h.recorder.getStatus()).toBe('idle')
  })

  it('收到 stop 之前不形成任何成片', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    rec.emitData(['x'])
    rec.emitData(['y'])
    expect(h.takes).toHaveLength(0)
    h.recorder.stop()
    expect(h.takes).toHaveLength(0)
    rec.emitStop()
    expect(h.takes).toHaveLength(1)
  })

  it('start 使用 timeslice 让尾段可持续到达', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    expect(rec.timeslice).toBe(250)
  })

  it('暂停与继续：暂停时长不计入成片时长', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    rec.emitData(['1'])

    h.clock.now = 2000 // 已录 1000ms
    h.recorder.pause()
    expect(h.recorder.getStatus()).toBe('paused')
    h.clock.now = 5000 // 暂停 3000ms
    h.recorder.resume()
    expect(h.recorder.getStatus()).toBe('recording')

    h.clock.now = 7000 // 继续后又录 2000ms
    rec.emitData(['2'])
    h.recorder.stop()
    rec.emitStop()

    expect(h.takes[0].durationMs).toBe(3000)
    const text = await readBlob(h.takes[0].blob)
    expect(text).toBe('1\n2\n')
  })
})

describe('重复操作幂等', () => {
  it('录制中重复 start 被忽略，不产生第二个 recorder/流', async () => {
    const h = makeHarness()
    await startTake(h)
    h.recorder.start()
    h.recorder.start()
    await h.flush()
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    expect(h.sessions).toHaveLength(1)
  })

  it('重复 pause/resume/stop 安全', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    rec.emitData(['x'])

    h.recorder.pause()
    h.recorder.pause()
    h.recorder.stop() // 暂停态允许停止
    expect(rec.stopCalls).toBe(1)
    h.recorder.stop() // 第二次无效
    expect(rec.stopCalls).toBe(1)

    // stop 后再 resume 无效
    h.recorder.resume()
    rec.emitStop()
    expect(h.takes).toHaveLength(1)
  })

  it('idle 下 pause/resume/stop 为无操作', async () => {
    const h = makeHarness()
    h.recorder.pause()
    h.recorder.resume()
    h.recorder.stop()
    await h.flush()
    expect(h.takes).toHaveLength(0)
    expect(h.errors).toHaveLength(0)
  })
})

describe('start 失败路径', () => {
  it('无任何受支持编码时禁止开拍并报 codec-unsupported', async () => {
    FakeMediaRecorder.supported = []
    const h = makeHarness()
    h.recorder.start()
    await h.flush()
    expect(h.errors[0]?.code).toBe('codec-unsupported')
    expect(h.recorder.getStatus()).toBe('idle')
    expect(h.sessions).toHaveLength(0) // 根本没去取设备
  })

  it('授权被拒绝：报 permission-denied 并回到 idle，不产出成片', async () => {
    const h = makeHarness({
      reject: new DOMException('denied', 'NotAllowedError'),
    })
    h.recorder.start()
    await h.flush()
    expect(h.errors[0]?.code).toBe('permission-denied')
    expect(h.recorder.getStatus()).toBe('idle')
    expect(h.takes).toHaveLength(0)
  })

  it('取流成功但 recorder 构造抛错：释放轨道、回 idle、报 start-failed', async () => {
    const h = makeHarness()
    FakeMediaRecorder.ctorThrows = new Error('construct boom')
    h.recorder.start()
    await h.flush()
    expect(h.errors[0]?.code).toBe('start-failed')
    expect(h.recorder.getStatus()).toBe('idle')
    const tracks = h.sessions[0].tracks
    expect(tracks.every((t) => t.readyState === 'ended')).toBe(true)
  })

  it('recorder.start 抛错：释放轨道并报 start-failed', async () => {
    const h = makeHarness()
    FakeMediaRecorder.startThrows = new DOMException(
      'could not start',
      'InvalidStateError',
    )
    h.recorder.start()
    await h.flush()
    expect(h.errors[0]?.code).toBe('start-failed')
    expect(h.recorder.getStatus()).toBe('idle')
    expect(h.sessions[0].tracks.every((t) => t.readyState === 'ended')).toBe(
      true,
    )
  })
})

describe('设备中断（轨道 ended / recorder error）', () => {
  it('轨道 ended 只触发一次停止，stop 到达后生成带 device-interrupted 标注的成片', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    rec.emitData(['pre'])

    // 拔掉摄像头：视频轨 ended
    const [videoTrack] = h.sessions[0].tracks
    h.clock.now = 1800
    videoTrack.emitEnded()

    expect(h.recorder.getStatus()).toBe('stopping')
    expect(rec.stopCalls).toBe(1)

    // 重复 ended（另一条轨也断了）不得二次停止
    const [, audioTrack] = h.sessions[0].tracks
    audioTrack.emitEnded()
    expect(rec.stopCalls).toBe(1)

    // 尾段晚到（在 stop 事件之前）：必须并入
    rec.emitData(['late-tail'])
    rec.emitStop()

    expect(h.takes).toHaveLength(1)
    const take = h.takes[0]
    expect(take.reason).toBe('device-interrupted')
    expect(await readBlob(take.blob)).toBe('pre\nlate-tail\n')
    // 中断后轨道被统一释放
    expect(
      h.sessions[0].tracks.every((t) => t.readyState === 'ended'),
    ).toBe(true)
  })

  it('无数据中断：只报错，不产生空成片', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    h.sessions[0].tracks[0].emitEnded()
    rec.emitStop()
    expect(h.takes).toHaveLength(0)
    expect(h.errors[0]?.code).toBe('empty-take')
    expect(h.settlements[0]?.reason).toBe('device-interrupted')
  })

  it('用户停止但全程只收到零字节数据：报 empty-take，不生成可回放的空壳成片', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    rec.emitEmptyData()
    rec.emitEmptyData() // 零字节 chunk 必须一律丢弃
    h.recorder.stop()
    rec.emitStop()
    expect(h.takes).toHaveLength(0)
    expect(h.errors[0]?.code).toBe('empty-take')
    expect(h.settlements[0]?.reason).toBe('user')
    expect(h.settlements[0]?.error?.code).toBe('empty-take')
  })

  it('recorder error 走同一中断路径，重复 error 只停一次', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    rec.emitData(['d1'])
    rec.emitError({ name: 'UnknownError', message: 'device gone' })
    rec.emitError({ name: 'UnknownError', message: 'again' })
    expect(rec.stopCalls).toBe(1)
    rec.emitData(['d2'])
    rec.emitStop()
    expect(h.takes).toHaveLength(1)
    expect(h.takes[0].reason).toBe('device-interrupted')
    expect(await readBlob(h.takes[0].blob)).toBe('d1\nd2\n')
  })

  it('中断后 stop() 对 inactive 抛 InvalidStateError 时，微任务兜底仍只产出一个成片', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    FakeMediaRecorder.stopThrowsOnInactive = true
    rec.emitData(['only'])
    // 真实拔除场景：UA 已让 recorder 进入 inactive（且不发 onstop）
    rec.state = 'inactive'
    h.sessions[0].tracks[0].emitEnded()
    // 没有任何 onstop 回调；等待兜底微任务
    await h.flush()
    expect(h.takes).toHaveLength(1)
    expect(h.takes[0].reason).toBe('device-interrupted')
    expect(await readBlob(h.takes[0].blob)).toBe('only\n')
  })
})

describe('stop / dataavailable 交错的会话隔离', () => {
  it('stop 到达后才到的陈旧 dataavailable 不得改变成片', async () => {
    const h = makeHarness()
    const rec1 = await startTake(h)
    rec1.emitData(['keep'])
    h.recorder.stop()
    rec1.emitStop()
    const take1 = h.takes[0]
    const content1 = await readBlob(take1.blob)
    expect(content1).toBe('keep\n')

    // 旧 recorder 的事件在新周期里晚到
    rec1.emitData(['STALE'])
    rec1.emitStop()
    expect(h.takes).toHaveLength(1)
    expect(await readBlob(h.takes[0].blob)).toBe('keep\n')
  })

  it('旧 take 的事件不得污染新 take', async () => {
    const h = makeHarness()
    const rec1 = await startTake(h)
    rec1.emitData(['one'])
    h.recorder.stop()
    rec1.emitStop()
    expect(h.takes).toHaveLength(1)

    const rec2 = await startTake(h)
    expect(rec2).not.toBe(rec1)
    // 旧 recorder 在新 take 进行中吐出迟到事件
    rec1.emitData(['ghost'])
    rec1.emitStop()
    rec2.emitData(['two'])
    h.recorder.stop()
    rec2.emitStop()

    expect(h.takes).toHaveLength(2)
    expect(await readBlob(h.takes[0].blob)).toBe('one\n')
    expect(await readBlob(h.takes[1].blob)).toBe('two\n')
  })

  it('最终轨道中断且尾段晚到：只生成一个可播放成片，且包含尾段', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    rec.emitData(['head'])

    // 轨道中断 → 内部请求 stop
    h.sessions[0].tracks[0].emitEnded()
    expect(h.recorder.getStatus()).toBe('stopping')

    // 尾段在 stop 事件之前晚到
    rec.emitData(['tail'])
    rec.emitStop()

    // stop 之后再到的数据必须丢弃
    rec.emitData(['after-stop'])
    rec.emitStop()
    rec.emitData(['after-stop-2'])

    expect(h.takes).toHaveLength(1)
    const take = h.takes[0]
    expect(await readBlob(take.blob)).toBe('head\ntail\n')
    // “可播放”：拥有非空 webm 类型 Blob 与对象 URL
    expect(take.blob.size).toBeGreaterThan(0)
    expect(take.blob.type).toContain('video/webm')
    expect(take.url).toBeTruthy()
  })

  it('stop 后立刻开拍新 take，旧 stop 事件迟到也不改变状态', async () => {
    const h = makeHarness()
    const rec1 = await startTake(h)
    rec1.emitData(['a'])
    h.recorder.stop()
    rec1.emitStop()

    const rec2 = await startTake(h)
    rec2.emitData(['b'])
    // 旧 stop 重放
    rec1.emitStop()
    expect(h.recorder.getStatus()).toBe('recording')
    h.recorder.stop()
    rec2.emitStop()
    expect(h.takes).toHaveLength(2)
  })
})

describe('dispose', () => {
  it('录制中卸载：停止全部轨道，不产生 take', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    rec.emitData(['x'])
    h.recorder.dispose()
    expect(
      h.sessions[0].tracks.every((t) => t.readyState === 'ended'),
    ).toBe(true)
    rec.emitData(['late'])
    rec.emitStop()
    expect(h.takes).toHaveLength(0)
    expect(h.recorder.getStatus()).toBe('idle')
  })

  it('dispose 后 start/pause/stop 均无效果', async () => {
    const h = makeHarness()
    h.recorder.dispose()
    h.recorder.start()
    await h.flush()
    expect(h.sessions).toHaveLength(0)
    expect(h.errors).toHaveLength(0)
  })
})

describe('依赖注入内核（自定义 deps）', () => {
  it('使用注入的 createObjectURL/randomId', async () => {
    const tracks = [new FakeTrack('video'), new FakeTrack('audio')]
    const created: FakeMediaRecorder[] = []
    class Ctor extends FakeMediaRecorder {
      constructor(stream: MediaStreamLike) {
        super(stream)
        created.push(this)
      }
    }
    const urls = new Map<string, Blob>()
    const deps: RecorderDeps = {
      MediaRecorder: Ctor,
      getUserMedia: async () => ({ getTracks: () => tracks }),
      createObjectURL: (b) => {
        const u = 'blob:custom/x'
        urls.set(u, b)
        return u
      },
      revokeObjectURL: (u) => urls.delete(u),
      now: () => 42,
      randomId: () => 'fixed-id',
      setTimer: (handler) => setTimeout(handler, 0),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
    const recorder = new CaptureRecorder(
      {
        onStatusChange: () => undefined,
        onTake: () => undefined,
        onError: () => undefined,
        onSettled: () => undefined,
      },
      deps,
    )
    recorder.start()
    await new Promise((r) => setTimeout(r, 0))
    created[0].emitData(['z'])
    recorder.stop()
    created[0].emitStop()
    // 仅验证可注入，成片读取由上面的用例保证
    expect(urls.size).toBe(1)
  })

  it('Take 满足交付版下载一致性：URL 指向的 Blob 即 take.blob', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    rec.emitData(['delivery'])
    h.recorder.stop()
    rec.emitStop()
    const take: Take = h.takes[0]
    expect(h.urls.get(take.url)).toBe(take.blob)
    expect(await readBlob(h.urls.get(take.url) as Blob)).toBe('delivery\n')
  })
})

async function startMode(
  h: Harness,
  mode: CaptureMode,
  devices: { videoDeviceId?: string; audioDeviceId?: string } = {},
) {
  h.recorder.start({ mode, ...devices })
  await h.flush()
  expect(h.recorder.getStatus()).toBe('recording')
  return h.lastRecorder()
}

function stopAndEmit(h: Harness, rec = h.lastRecorder()) {
  h.recorder.stop()
  rec.emitStop()
}

describe('三种模式独立探测 MIME', () => {
  it('默认替身：三模式各自选出候选表的首个受支持项', () => {
    const h = makeHarness()
    expect(h.recorder.getSupportedMimeType('av')).toBe(
      MODE_MIME_CANDIDATES.av[0],
    )
    expect(h.recorder.getSupportedMimeType('video-only')).toBe(
      MODE_MIME_CANDIDATES['video-only'][0],
    )
    expect(h.recorder.getSupportedMimeType('audio-only')).toBe(
      MODE_MIME_CANDIDATES['audio-only'][0],
    )
    const caps = h.recorder.getSupportedMimeTypes()
    expect(Object.keys(caps).sort()).toEqual(
      ['audio-only', 'av', 'video-only'].sort(),
    )
  })

  it('纯 audio/webm 环境：仅音频可用（audio/webm;codecs=opus 不支持时回退裸 audio/webm）', () => {
    FakeMediaRecorder.supported = ['audio/webm']
    const h = makeHarness()
    expect(h.recorder.getSupportedMimeType('av')).toBeNull()
    expect(h.recorder.getSupportedMimeType('video-only')).toBeNull()
    expect(h.recorder.getSupportedMimeType('audio-only')).toBe('audio/webm')
  })

  it('仅音频模式按 opus → 裸 audio/webm 顺序探测', () => {
    FakeMediaRecorder.supported = ['audio/webm;codecs=opus']
    const h = makeHarness()
    expect(h.recorder.getSupportedMimeType('audio-only')).toBe(
      'audio/webm;codecs=opus',
    )
    // av/仅视频候选均不含 audio MIME：这两个模式被禁用
    expect(h.recorder.getSupportedMimeType('av')).toBeNull()
    expect(h.recorder.getSupportedMimeType('video-only')).toBeNull()
  })

  it('视频编码全部不可用（仅 opus 音频可用）：只禁用两个视频模式，音频模式不受影响', () => {
    FakeMediaRecorder.supported = ['audio/webm;codecs=opus', 'audio/webm']
    const h = makeHarness()
    expect(h.recorder.getSupportedMimeType('av')).toBeNull()
    expect(h.recorder.getSupportedMimeType('video-only')).toBeNull()
    expect(h.recorder.getSupportedMimeType('audio-only')).toBe(
      'audio/webm;codecs=opus',
    )
  })

  it('仅视频按 vp9 → vp8 → 裸 video/webm 顺序回退', () => {
    FakeMediaRecorder.supported = ['video/webm;codecs=vp8', 'video/webm']
    const h = makeHarness()
    expect(h.recorder.getSupportedMimeType('video-only')).toBe(
      'video/webm;codecs=vp8',
    )
    FakeMediaRecorder.supported = ['video/webm']
    expect(h.recorder.getSupportedMimeType('video-only')).toBe('video/webm')
  })

  it('音视频沿用 vp9,opus → vp8,opus → video/webm（与旧 MIME_CANDIDATES 一致）', () => {
    expect(MODE_MIME_CANDIDATES.av).toEqual(MIME_CANDIDATES)
    FakeMediaRecorder.supported = [
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ]
    const h = makeHarness()
    expect(h.recorder.getSupportedMimeType('av')).toBe(
      'video/webm;codecs=vp8,opus',
    )
  })

  it('选中无能力的模式开拍：只报 codec-unsupported，不取设备、不动旧 take', async () => {
    FakeMediaRecorder.supported = ['audio/webm']
    const h = makeHarness()
    h.recorder.start({ mode: 'av' })
    await h.flush()
    expect(h.errors[0]?.code).toBe('codec-unsupported')
    expect(h.recorder.getStatus()).toBe('idle')
    expect(h.sessions).toHaveLength(0)
    expect(h.takes).toHaveLength(0)
    // 其它模式能力仍保留：切到仅音频即可开拍
    h.recorder.start({ mode: 'audio-only' })
    await h.flush()
    expect(h.recorder.getStatus()).toBe('recording')
  })
})

describe('采集计划只请求所需轨道', () => {
  it('仅音频：video:false，流中只有音频轨，take 标记 audio-only', async () => {
    const h = makeHarness()
    const rec = await startMode(h, 'audio-only', {
      videoDeviceId: 'cam-x',
      audioDeviceId: 'mic-y',
    })
    expect(h.calls[0]).toEqual(
      expectedConstraints('audio-only', undefined, 'mic-y'),
    )
    expect(h.calls[0]?.video).toBe(false)
    const tracks = h.sessions[0].tracks
    expect(tracks.map((t) => t.kind)).toEqual(['audio'])

    rec.emitData(['sound'])
    stopAndEmit(h, rec)
    const take = h.takes[0]
    expect(take.mode).toBe('audio-only')
    expect(take.mimeType).toBe('audio/webm;codecs=opus')
    expect(take.blob.type).toBe('audio/webm;codecs=opus')
  })

  it('仅视频：audio:false，不相关的视频设备 id 也不进入音频约束', async () => {
    const h = makeHarness()
    const rec = await startMode(h, 'video-only', {
      videoDeviceId: 'cam-1',
      audioDeviceId: 'mic-ignored',
    })
    expect(h.calls[0]).toEqual(expectedConstraints('video-only', 'cam-1'))
    expect(h.calls[0]?.audio).toBe(false)
    expect(h.sessions[0].tracks.map((t) => t.kind)).toEqual(['video'])
    rec.emitData(['frames'])
    stopAndEmit(h, rec)
    expect(h.takes[0].mode).toBe('video-only')
    expect(h.takes[0].mimeType).toBe('video/webm;codecs=vp9')
  })

  it('音视频：video/audio 均请求，无参 start 兼容为 av', async () => {
    const h = makeHarness()
    h.recorder.start()
    await h.flush()
    expect(h.recorder.getStatus()).toBe('recording')
    expect(h.calls[0]).toEqual(expectedConstraints('av'))
    expect(h.sessions[0].tracks.map((t) => t.kind)).toEqual([
      'video',
      'audio',
    ])
  })

  it('麦克风物理不存在时仅视频仍成功；缺少无关设备不算失败', async () => {
    const h = makeHarness({ missingKinds: ['audio'] })
    const rec = await startMode(h, 'video-only')
    expect(h.sessions[0].tracks.map((t) => t.kind)).toEqual(['video'])
    rec.emitData(['no-mic-needed'])
    stopAndEmit(h, rec)
    expect(h.takes).toHaveLength(1)
    expect(h.errors).toHaveLength(0)
    expect(h.takes[0].mode).toBe('video-only')
  })

  it('仅音频时即使没有摄像头也成功（video:false 不会触发 NotFound）', async () => {
    const h = makeHarness({ missingKinds: ['video'] })
    const rec = await startMode(h, 'audio-only')
    expect(h.sessions[0].tracks.map((t) => t.kind)).toEqual(['audio'])
    rec.emitData(['voice'])
    stopAndEmit(h, rec)
    expect(h.takes).toHaveLength(1)
  })
})

describe('设备身份随开拍冻结并随成片固化', () => {
  it('av：deviceId 与展示名在 starting 即可读，成片携带同一身份', async () => {
    const h = makeHarness({ manualPermissions: true })
    h.recorder.start({
      mode: 'av',
      videoDeviceId: 'cam-A',
      audioDeviceId: 'mic-A',
      videoDeviceLabel: '前台机位',
      audioDeviceLabel: '领夹麦',
    })
    expect(h.recorder.getStatus()).toBe('starting')
    // 授权未决时冻结身份已可读（界面据此展示，不依赖枚举清单）
    expect(h.recorder.getActiveVideoDevice()).toEqual({
      id: 'cam-A',
      label: '前台机位',
    })
    expect(h.recorder.getActiveAudioDevice()).toEqual({
      id: 'mic-A',
      label: '领夹麦',
    })
    // 约束只认冻结的 id
    expect(h.calls[0]).toEqual(expectedConstraints('av', 'cam-A', 'mic-A'))

    h.media.grant()
    await h.flush()
    const rec = h.lastRecorder()
    // 录制中身份不变
    expect(h.recorder.getActiveVideoDevice()?.id).toBe('cam-A')
    rec.emitData(['frozen-identity'])
    stopAndEmit(h, rec)
    expect(h.takes[0].videoDevice).toEqual({ id: 'cam-A', label: '前台机位' })
    expect(h.takes[0].audioDevice).toEqual({ id: 'mic-A', label: '领夹麦' })
    // 回 idle 后活动身份清空
    expect(h.recorder.getActiveVideoDevice()).toBeNull()
    expect(h.recorder.getActiveAudioDevice()).toBeNull()
  })

  it('仅视频/仅音频：与模式无关的设备身份为 null，但传入 id 也不进入约束', async () => {
    const hVideo = makeHarness()
    const recV = hVideo.recorder
    recV.start({
      mode: 'video-only',
      videoDeviceId: 'cam-only',
      videoDeviceLabel: '特写机位',
      audioDeviceId: 'mic-ignored',
      audioDeviceLabel: '不应出现',
    })
    await hVideo.flush()
    expect(recV.getActiveVideoDevice()).toEqual({
      id: 'cam-only',
      label: '特写机位',
    })
    expect(recV.getActiveAudioDevice()).toBeNull()
    const rv = hVideo.lastRecorder()
    rv.emitData(['v'])
    stopAndEmit(hVideo, rv)
    expect(hVideo.takes[0].videoDevice).toEqual({
      id: 'cam-only',
      label: '特写机位',
    })
    expect(hVideo.takes[0].audioDevice).toBeNull()

    const hAudio = makeHarness()
    const recA = hAudio.recorder
    recA.start({
      mode: 'audio-only',
      audioDeviceId: 'mic-only',
      audioDeviceLabel: '吊杆麦',
      videoDeviceId: 'cam-ignored',
    })
    await hAudio.flush()
    expect(recA.getActiveAudioDevice()).toEqual({
      id: 'mic-only',
      label: '吊杆麦',
    })
    expect(recA.getActiveVideoDevice()).toBeNull()
    const ra = hAudio.lastRecorder()
    ra.emitData(['a'])
    stopAndEmit(hAudio, ra)
    expect(hAudio.takes[0].audioDevice).toEqual({
      id: 'mic-only',
      label: '吊杆麦',
    })
    expect(hAudio.takes[0].videoDevice).toBeNull()
  })

  it('未给设备 id/label：冻结为系统默认（id 空串），约束退化为 true', async () => {
    const h = makeHarness()
    h.recorder.start({ mode: 'av' })
    await h.flush()
    expect(h.recorder.getActiveVideoDevice()).toEqual({ id: '', label: '' })
    expect(h.calls[0]).toEqual({ video: true, audio: true })
    const rec = h.lastRecorder()
    rec.emitData(['default-dev'])
    stopAndEmit(h, rec)
    expect(h.takes[0].videoDevice?.id).toBe('')
    expect(h.takes[0].audioDevice?.id).toBe('')
  })
})

describe('开拍冻结（等待授权期间）', () => {
  it('点击开拍在权限申请前进入 starting 并冻结模式/MIME，授权后按冻结参数成片', async () => {
    const h = makeHarness({ manualPermissions: true })
    h.recorder.start({
      mode: 'audio-only',
      videoDeviceId: 'cam',
      audioDeviceId: 'mic',
    })
    expect(h.recorder.getStatus()).toBe('starting')
    expect(h.recorder.getActiveMode()).toBe('audio-only')
    expect(h.recorder.getActiveMimeType()).toBe('audio/webm;codecs=opus')
    expect(h.media.pending).toHaveLength(1)
    expect(h.media.calls[0]).toEqual(
      expectedConstraints('audio-only', undefined, 'mic'),
    )

    // 等待授权期间重复 start：被状态守卫挡下，不产生第二次取流
    h.recorder.start({ mode: 'video-only' })
    h.recorder.start({})
    expect(h.media.pending).toHaveLength(1)

    // 授权期间环境“能力”即便变化也无影响：冻结 MIME 不再重探
    FakeMediaRecorder.supported = ['video/webm']

    h.media.grant()
    await h.flush()
    expect(h.recorder.getStatus()).toBe('recording')
    expect(h.recorder.getActiveMode()).toBe('audio-only')
    const rec = h.lastRecorder()
    expect(rec.mimeType).toBe('audio/webm;codecs=opus')
    rec.emitData(['frozen'])
    stopAndEmit(h, rec)
    expect(h.takes[0].mode).toBe('audio-only')
    expect(h.takes[0].mimeType).toBe('audio/webm;codecs=opus')
    expect(h.takes[0].blob.type).toBe('audio/webm;codecs=opus')
    // 回到 idle 才解锁
    expect(h.recorder.getStatus()).toBe('idle')
    expect(h.recorder.getActiveMode()).toBeNull()
    expect(h.recorder.getActiveMimeType()).toBeNull()
  })

  it('等待授权时切换模式/重复开始不能让取流约束漂移', async () => {
    const h = makeHarness({ manualPermissions: true })
    h.recorder.start({
      mode: 'video-only',
      videoDeviceId: 'cam-A',
      audioDeviceId: 'mic-A',
    })
    expect(h.recorder.getStatus()).toBe('starting')
    expect(h.media.calls[0]).toEqual(
      expectedConstraints('video-only', 'cam-A'),
    )

    // 内核层面：重复 start 携带任何模式/设备都无效
    h.recorder.start({
      mode: 'audio-only',
      videoDeviceId: 'cam-B',
      audioDeviceId: 'mic-B',
    })
    expect(h.media.pending).toHaveLength(1)
    expect(h.media.calls).toHaveLength(1)
    expect(h.media.calls[0]).toEqual(
      expectedConstraints('video-only', 'cam-A'),
    )
    expect(h.recorder.getActiveMode()).toBe('video-only')

    h.media.grant()
    await h.flush()
    const rec = h.lastRecorder()
    expect(rec.mimeType).toBe('video/webm;codecs=vp9')
    rec.emitData(['locked'])
    stopAndEmit(h, rec)
    expect(h.takes[0].mode).toBe('video-only')
    expect(h.takes[0].mimeType).toBe('video/webm;codecs=vp9')
  })

  it('授权拒绝：释放期间无新流、回 idle，各模式能力与旧 take 均保留', async () => {
    const h = makeHarness({ manualPermissions: true })

    // 先正常录一条旧的 av 成片
    h.recorder.start({ mode: 'av' })
    h.media.grant()
    await h.flush()
    const r0 = h.lastRecorder()
    r0.emitData(['old'])
    stopAndEmit(h, r0)
    expect(h.takes).toHaveLength(1)

    // 第二次开拍改走仅视频，授权被拒
    h.recorder.start({ mode: 'video-only' })
    expect(h.recorder.getStatus()).toBe('starting')
    h.media.deny()
    await h.flush()
    expect(h.recorder.getStatus()).toBe('idle')
    expect(h.errors[0]?.code).toBe('permission-denied')
    // 没有产生新会话流，旧成片原样保留
    expect(h.media.sessions).toHaveLength(1)
    expect(h.takes).toHaveLength(1)
    expect(h.takes[0].mimeType).toBe('video/webm;codecs=vp9,opus')
    // 解锁后各模式能力仍在，可再次开拍
    expect(h.recorder.getSupportedMimeType('video-only')).toBe(
      'video/webm;codecs=vp9',
    )
    h.recorder.start({ mode: 'video-only' })
    h.media.grant()
    await h.flush()
    expect(h.recorder.getStatus()).toBe('recording')
  })

  it('授权后迟到的流在回 idle/新会话时被释放（会话守卫不漂移）', async () => {
    const h = makeHarness({ manualPermissions: true })
    h.recorder.start({ mode: 'audio-only' })
    h.media.deny()
    await h.flush()
    expect(h.recorder.getStatus()).toBe('idle')
    // 第二次开拍：前一次的 pending 已消费，新的授权正常
    h.recorder.start({ mode: 'audio-only' })
    expect(h.recorder.getStatus()).toBe('starting')
    h.media.grant()
    await h.flush()
    expect(h.recorder.getStatus()).toBe('recording')
  })
})

describe('失败后模式能力与资源保留', () => {
  it('仅视频 recorder 构造失败：释放新流、回 idle，音频模式能力不受影响', async () => {
    const h = makeHarness()
    FakeMediaRecorder.ctorThrows = new Error('ctor boom')
    h.recorder.start({ mode: 'video-only' })
    await h.flush()
    expect(h.errors[0]?.code).toBe('start-failed')
    expect(h.recorder.getStatus()).toBe('idle')
    expect(h.sessions[0].tracks.every((t) => t.readyState === 'ended')).toBe(
      true,
    )
    FakeMediaRecorder.ctorThrows = null
    // 两种模式能力都保留
    expect(h.recorder.getSupportedMimeType('av')).toBe(
      'video/webm;codecs=vp9,opus',
    )
    expect(h.recorder.getSupportedMimeType('audio-only')).toBe(
      'audio/webm;codecs=opus',
    )
    const rec = await startMode(h, 'audio-only')
    rec.emitData(['recovered'])
    stopAndEmit(h, rec)
    expect(h.takes[0].mode).toBe('audio-only')
  })

  it('旧 take 的暂停/收尾/中断行为在模式化后保持一致（av 无参 start）', async () => {
    const h = makeHarness()
    const rec = await startTake(h) // 无参 → av
    h.clock.now = 2000
    h.recorder.pause()
    h.clock.now = 4000
    h.recorder.resume()
    rec.emitData(['a'])
    h.clock.now = 3000
    h.sessions[0].tracks[0].emitEnded() // 视频轨中断
    rec.emitData(['tail'])
    rec.emitStop()
    expect(h.takes).toHaveLength(1)
    expect(h.takes[0].reason).toBe('device-interrupted')
    expect(h.takes[0].mode).toBe('av')
    expect(await readBlob(h.takes[0].blob)).toBe('a\ntail\n')
  })
})

/**
 * 确定性结局验收：取消/失败不得生成半成品；成片时长冻结在停止或中断时刻，
 * 排除全部暂停、授权与封装等待；所有轨道必释放；页面绝不久留 stopping。
 * 全部用例以可控权限 Promise、虚拟时钟与伪 MediaRecorder 驱动。
 */
describe('确定结局：授权中取消 / 暂停中停止 / 延迟结束 / 停止抛错 / 无结束事件', () => {
  describe('授权弹窗未决时取消', () => {
    it('starting 中 stop() 即取消：回 idle、无成片无错误、轨道不残留、可立即改模式重拍', async () => {
      const h = makeHarness({ manualPermissions: true })
      h.recorder.start({
        mode: 'audio-only',
        audioDeviceId: 'mic-1',
      })
      expect(h.recorder.getStatus()).toBe('starting')
      expect(h.media.pending).toHaveLength(1)

      // 授权迟迟不返回时，停止入口可用
      h.recorder.stop()

      expect(h.recorder.getStatus()).toBe('idle')
      expect(h.takes).toHaveLength(0) // 取消不产生半成品
      expect(h.errors).toHaveLength(0)
      expect(h.settlements).toHaveLength(0)
      expect(h.recorder.getActiveMode()).toBeNull()
      expect(h.clock.pendingCount).toBe(0)

      // 授权弹窗此后才返回：迟到的流必须被立即释放，且不产生 recorder/成片
      h.media.grant()
      await h.flush()
      expect(h.recorder.getStatus()).toBe('idle')
      expect(h.takes).toHaveLength(0)
      expect(FakeMediaRecorder.instances).toHaveLength(0)
      expect(
        h.media.sessions[0].tracks.every((t) => t.readyState === 'ended'),
      ).toBe(true)

      // 解锁：可切换模式并再次开拍
      h.recorder.start({ mode: 'video-only' })
      expect(h.media.pending).toHaveLength(1)
      h.media.grant()
      await h.flush()
      expect(h.recorder.getStatus()).toBe('recording')
      const rec = h.lastRecorder()
      expect(rec.mimeType).toBe('video/webm;codecs=vp9')
      rec.emitData(['retry'])
      stopAndEmit(h, rec)
      expect(h.takes).toHaveLength(1)
      expect(h.takes[0].mode).toBe('video-only')
    })

    it('取消后迟到的拒绝结果同样被吞掉：不报错、可重拍', async () => {
      const h = makeHarness({ manualPermissions: true })
      h.recorder.start({ mode: 'av' })
      h.recorder.stop()
      expect(h.recorder.getStatus()).toBe('idle')

      h.media.deny()
      await h.flush()
      expect(h.errors).toHaveLength(0)
      expect(h.recorder.getStatus()).toBe('idle')

      h.recorder.start({ mode: 'av' })
      h.media.grant()
      await h.flush()
      expect(h.recorder.getStatus()).toBe('recording')
    })

    it('等待授权期间取消不影响旧 take 与既有交付素材', async () => {
      const h = makeHarness({ manualPermissions: true })
      h.recorder.start({ mode: 'av' })
      h.media.grant()
      await h.flush()
      const old = h.lastRecorder()
      old.emitData(['old-take'])
      stopAndEmit(h, old)
      expect(h.takes).toHaveLength(1)
      const oldTake = h.takes[0]

      h.recorder.start({ mode: 'audio-only' })
      h.recorder.stop()
      expect(h.takes).toHaveLength(1)
      expect(h.takes[0]).toBe(oldTake)
      expect(h.errors).toHaveLength(0)
      expect(h.recorder.getStatus()).toBe('idle')
    })
  })

  describe('暂停中停止', () => {
    it('暂停态停止：时长冻结在暂停时刻，已录片段不重复累计、暂停时间不计入', async () => {
      const h = makeHarness()
      const rec = await startTake(h) // t0 = 1000

      rec.emitData(['seg1'])
      h.clock.advance(1000) // → 2000，录了 1000
      h.recorder.pause()
      h.clock.advance(5000) // → 7000，暂停了 5000（必须排除）

      h.recorder.stop()
      expect(h.recorder.getStatus()).toBe('stopping')
      // 封装再慢也不改变冻结的时长
      h.clock.advance(3000) // → 10000
      rec.emitStop()

      expect(h.takes).toHaveLength(1)
      expect(h.takes[0].durationMs).toBe(1000)
      expect(await readBlob(h.takes[0].blob)).toBe('seg1\n')
      expect(h.recorder.getStatus()).toBe('idle')
    })

    it('多段录制后在暂停中停止：只累计各录制段，暂停段全部排除', async () => {
      const h = makeHarness()
      const rec = await startTake(h) // 1000
      h.clock.advance(1000) // 段一 1000
      h.recorder.pause()
      h.clock.advance(4000) // 暂停一 4000
      h.recorder.resume()
      h.clock.advance(2000) // 段二 2000
      rec.emitData(['seg2'])
      h.recorder.pause()
      h.clock.advance(6000) // 暂停二 6000
      h.recorder.stop()
      h.clock.advance(2000) // 封装等待 2000
      rec.emitStop()

      expect(h.takes[0].durationMs).toBe(3000)
    })
  })

  describe('延迟结束事件', () => {
    it('正常停止后编码器延迟派发 stop：封装等待不计入素材长度', async () => {
      const h = makeHarness()
      const rec = await startTake(h) // 1000
      h.clock.advance(2500) // → 3500，已录 2500
      rec.emitData(['a'])
      h.recorder.stop()
      expect(h.recorder.getStatus()).toBe('stopping')

      // stop 事件迟迟不来（但在兜底窗口内）
      h.clock.advance(STOP_FINALIZE_GRACE_MS - 100)
      expect(h.recorder.getStatus()).toBe('stopping')
      rec.emitData(['tail']) // 晚到尾段仍并入
      rec.emitStop()

      expect(h.takes).toHaveLength(1)
      expect(h.takes[0].durationMs).toBe(2500)
      expect(await readBlob(h.takes[0].blob)).toBe('a\ntail\n')
      expect(h.recorder.getStatus()).toBe('idle')
      expect(h.clock.pendingCount).toBe(0)
      expect(
        h.sessions[0].tracks.every((t) => t.readyState === 'ended'),
      ).toBe(true)
    })

    it('设备中断后结束事件延迟：时长冻结在中断时刻，原因保持 device-interrupted', async () => {
      const h = makeHarness()
      const rec = await startTake(h) // 1000
      h.clock.advance(1200) // → 2200
      rec.emitData(['pre'])
      h.sessions[0].tracks[0].emitEnded() // 中断即冻结
      expect(h.recorder.getStatus()).toBe('stopping')

      // 尾段与 stop 都在兜底窗口内晚到：中断后的时间全部排除，尾段仍并入
      h.clock.advance(STOP_FINALIZE_GRACE_MS - 100)
      rec.emitData(['tail'])
      rec.emitStop()

      expect(h.takes).toHaveLength(1)
      expect(h.takes[0].reason).toBe('device-interrupted')
      expect(h.takes[0].durationMs).toBe(1200)
      expect(await readBlob(h.takes[0].blob)).toBe('pre\ntail\n')
    })
  })

  describe('录制器拒绝停止 / 始终不发结束事件', () => {
    it('stop() 在 recording 态抛错：宽限窗口后强制收尾，回 idle、释放轨道、保留已录数据', async () => {
      const h = makeHarness()
      const rec = await startTake(h) // 1000
      h.clock.advance(1500)
      rec.emitData(['captured'])
      FakeMediaRecorder.stopThrows = new DOMException(
        'recorder refuses',
        'InvalidStateError',
      )

      h.recorder.stop()
      expect(rec.stopCalls).toBe(1)
      expect(h.recorder.getStatus()).toBe('stopping')
      expect(h.takes).toHaveLength(0)

      // 不到窗口不强收
      h.clock.advance(STOP_FINALIZE_GRACE_MS - 1)
      expect(h.recorder.getStatus()).toBe('stopping')
      expect(h.takes).toHaveLength(0)

      // 窗口到达：强制落定，数据可用（时长冻结在停止时刻）
      h.clock.advance(1)
      expect(h.recorder.getStatus()).toBe('idle')
      expect(h.takes).toHaveLength(1)
      expect(h.takes[0].durationMs).toBe(1500)
      expect(await readBlob(h.takes[0].blob)).toBe('captured\n')
      expect(
        h.sessions[0].tracks.every((t) => t.readyState === 'ended'),
      ).toBe(true)
      expect(h.clock.pendingCount).toBe(0)

      // 强制收尾后 recorder 的迟到事件一律丢弃，结局唯一
      rec.emitData(['ghost'])
      rec.emitStop()
      expect(h.takes).toHaveLength(1)

      // 会话已解锁：可立即再录一条
      FakeMediaRecorder.stopThrows = null
      const rec2 = await startTake(h)
      rec2.emitData(['next'])
      stopAndEmit(h, rec2)
      expect(h.takes).toHaveLength(2)
    })

    it('stop() 抛错且全程无数据：以 stop-failed 失败收场，不产生半成品', async () => {
      const h = makeHarness()
      await startTake(h)
      FakeMediaRecorder.stopThrows = new Error('hard stop failure')
      h.recorder.stop()
      h.clock.advance(STOP_FINALIZE_GRACE_MS)

      expect(h.recorder.getStatus()).toBe('idle')
      expect(h.takes).toHaveLength(0)
      expect(h.errors[0]?.code).toBe('stop-failed')
      expect(h.settlements[0]?.reason).toBe('user')
      expect(h.settlements[0]?.error?.code).toBe('stop-failed')
      expect(
        h.sessions[0].tracks.every((t) => t.readyState === 'ended'),
      ).toBe(true)
    })

    it('stop() 正常返回但永不派发 stop 事件：兜底强制成片（已有数据），素材不含封装等待', async () => {
      const h = makeHarness()
      const rec = await startTake(h) // 1000
      h.clock.advance(800)
      rec.emitData(['only-data'])
      h.recorder.stop()
      expect(rec.stopCalls).toBe(1)

      // 编码器始终沉默：推进远超窗口的时间也不能改变冻结时长
      h.clock.advance(10 * STOP_FINALIZE_GRACE_MS)
      expect(h.recorder.getStatus()).toBe('idle')
      expect(h.takes).toHaveLength(1)
      expect(h.takes[0].durationMs).toBe(800)
      expect(await readBlob(h.takes[0].blob)).toBe('only-data\n')
      expect(
        h.sessions[0].tracks.every((t) => t.readyState === 'ended'),
      ).toBe(true)
    })

    it('stop() 返回但无结束事件且无数据：报 stop-failed，旧成片与选择不受影响', async () => {
      const h = makeHarness({ manualPermissions: true })
      // 先录一条旧成片
      h.recorder.start({ mode: 'av' })
      h.media.grant()
      await h.flush()
      const old = h.lastRecorder()
      old.emitData(['old'])
      stopAndEmit(h, old)
      const oldTake = h.takes[0]

      // 第二条：编码器拒绝落定且无数据
      h.recorder.start({ mode: 'av' })
      h.media.grant()
      await h.flush()
      const stuck = h.lastRecorder()
      h.recorder.stop()
      h.clock.advance(STOP_FINALIZE_GRACE_MS)

      expect(h.recorder.getStatus()).toBe('idle')
      expect(h.takes).toHaveLength(1)
      expect(h.takes[0]).toBe(oldTake)
      expect(h.errors[0]?.code).toBe('stop-failed')
      expect(stuck.onstop).toBeNull()
    })

    it('设备中断后编码器始终沉默：兜底释放悬挂会话，时长冻结在中断时刻', async () => {
      const h = makeHarness()
      const rec = await startTake(h) // 1000
      h.clock.advance(900)
      rec.emitData(['before-pull'])
      h.sessions[0].tracks[0].emitEnded()
      expect(h.recorder.getStatus()).toBe('stopping')

      // 没有任何 stop 事件（悬挂会话）
      h.clock.advance(STOP_FINALIZE_GRACE_MS + 5000)
      expect(h.recorder.getStatus()).toBe('idle')
      expect(h.takes).toHaveLength(1)
      expect(h.takes[0].reason).toBe('device-interrupted')
      expect(h.takes[0].durationMs).toBe(900)
      expect(
        h.sessions[0].tracks.every((t) => t.readyState === 'ended'),
      ).toBe(true)
      expect(h.clock.pendingCount).toBe(0)
    })

    it('无数据设备中断且无结束事件：空会话失败收场，轨道释放、可再录制', async () => {
      const h = makeHarness()
      await startTake(h)
      h.sessions[0].tracks[0].emitEnded()
      h.clock.advance(STOP_FINALIZE_GRACE_MS)

      expect(h.recorder.getStatus()).toBe('idle')
      expect(h.takes).toHaveLength(0)
      expect(h.errors).toHaveLength(1)
      expect(
        h.sessions[0].tracks.every((t) => t.readyState === 'ended'),
      ).toBe(true)

      const rec2 = await startTake(h)
      rec2.emitData(['recovered'])
      stopAndEmit(h, rec2)
      expect(h.takes).toHaveLength(1)
    })
  })

  describe('会话结局唯一性', () => {
    it('兜底定时器与真实 stop 事件竞争：先到者落定，不产生第二个成片', async () => {
      const h = makeHarness()
      const rec = await startTake(h)
      h.clock.advance(600)
      rec.emitData(['win'])
      h.recorder.stop()

      // 恰在窗口边界前，真实 stop 到达
      h.clock.advance(STOP_FINALIZE_GRACE_MS - 1)
      rec.emitStop()
      expect(h.takes).toHaveLength(1)

      // 兜底定时器即便残留触发也是空操作
      h.clock.advance(10)
      expect(h.takes).toHaveLength(1)
      expect(h.clock.pendingCount).toBe(0)
      expect(h.recorder.getStatus()).toBe('idle')
    })

    it('停止落定后旧 recorder 的任何迟到事件都被丢弃', async () => {
      const h = makeHarness()
      const rec = await startTake(h)
      rec.emitData(['solo'])
      h.recorder.stop()
      h.clock.advance(STOP_FINALIZE_GRACE_MS) // 兜底落定
      expect(h.takes).toHaveLength(1)

      rec.emitData(['late1'])
      rec.emitError({ name: 'UnknownError', message: 'late' })
      rec.emitStop()
      rec.emitData(['late2'])
      expect(h.takes).toHaveLength(1)
      expect(await readBlob(h.takes[0].blob)).toBe('solo\n')
      expect(h.errors).toHaveLength(0)
    })

    it('starting 中 dispose：迟到授权结果的流被释放，状态确定为 idle', async () => {
      const h = makeHarness({ manualPermissions: true })
      h.recorder.start({ mode: 'av' })
      h.recorder.dispose()
      expect(h.recorder.getStatus()).toBe('idle')

      h.media.grant()
      await h.flush()
      expect(h.takes).toHaveLength(0)
      expect(
        h.media.sessions[0].tracks.every((t) => t.readyState === 'ended'),
      ).toBe(true)
    })
  })
})
