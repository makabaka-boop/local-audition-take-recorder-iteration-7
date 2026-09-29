import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { FakeMediaRecorder, FakeTrack } from '../test/fakes'
import { makeHarness } from '../test/harness'

/**
 * 开拍预检的交错时序验收：
 * - 预检只取一次流，确认开拍只做同流所有权转交；
 * - 取消旧预检后允许按新模式/设备重新申请，迟到授权按代次释放；
 * - 轨道在预检期间提前结束、录制器启动失败都只释放本次资源且不产生 take。
 */
beforeEach(() => {
  FakeMediaRecorder.reset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('开拍预检与同流交接', () => {
  it('授权后停留在 preview，不产生 recorder/take；确认开拍复用同一流且不再取设备', async () => {
    const h = makeHarness({ manualPermissions: true })

    h.recorder.beginPreflight({
      mode: 'av',
      videoDeviceId: 'cam-1',
      audioDeviceId: 'mic-1',
    })
    expect(h.recorder.getStatus()).toBe('starting')
    expect(h.calls).toHaveLength(1)

    h.media.grant()
    await h.flush()
    expect(h.recorder.getStatus()).toBe('preview')
    expect(FakeMediaRecorder.instances).toHaveLength(0)
    expect(h.takes).toHaveLength(0)

    const stream = h.media.sessions[0].stream
    expect(h.recorder.getActiveStream()).toBe(stream)
    expect(stream.getTracks().every((track) => track.readyState === 'live')).toBe(true)

    h.recorder.confirmStart()
    expect(h.recorder.getStatus()).toBe('recording')
    expect(h.calls).toHaveLength(1)
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    expect(h.recorder.getActiveStream()).toBe(stream)
    expect(stream.getTracks().every((track) => track.readyState === 'live')).toBe(true)

    const rec = h.lastRecorder()
    rec.emitData(['same-stream'])
    h.recorder.stop()
    rec.emitStop()
    expect(h.takes).toHaveLength(1)
    expect(
      stream.getTracks().map((track) => (track as FakeTrack).stopCalls),
    ).toEqual([1, 1])
  })

  it('预检中重复确认或重复取流均无效', async () => {
    const h = makeHarness()

    h.recorder.beginPreflight()
    await h.flush()
    expect(h.recorder.getStatus()).toBe('preview')

    h.recorder.beginPreflight({ mode: 'audio-only' })
    h.recorder.confirmStart()
    h.recorder.confirmStart()

    expect(h.calls).toHaveLength(1)
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    expect(h.recorder.getActiveMode()).toBe('av')
  })

  it('取消预览会释放本次每条轨道一次；取消后可改模式重新预检', async () => {
    const h = makeHarness()

    h.recorder.beginPreflight({ mode: 'av' })
    await h.flush()
    const stream = h.sessions[0].stream
    expect(h.recorder.getStatus()).toBe('preview')

    h.recorder.stop()
    expect(h.recorder.getStatus()).toBe('idle')
    expect(h.takes).toHaveLength(0)
    expect(FakeMediaRecorder.instances).toHaveLength(0)
    expect(
      stream.getTracks().map((track) => (track as FakeTrack).stopCalls),
    ).toEqual([1, 1])

    h.recorder.beginPreflight({ mode: 'video-only' })
    await h.flush()
    expect(h.recorder.getStatus()).toBe('preview')
    expect(h.sessions).toHaveLength(2)
    expect(h.sessions[1].tracks.map((track) => track.kind)).toEqual(['video'])
  })

  it('取消旧授权后重新申请：旧授权晚到时其流归旧代次并释放，新预检仍可成功', async () => {
    const h = makeHarness({ manualPermissions: true })

    h.recorder.beginPreflight({ mode: 'av' })
    h.recorder.stop()
    expect(h.recorder.getStatus()).toBe('idle')

    h.recorder.beginPreflight({ mode: 'video-only' })
    expect(h.media.pending).toHaveLength(2)

    // 第一代授权晚到：只能释放它自己的 av 流，不能进入第二代预检。
    h.media.grant()
    await h.flush()
    expect(h.recorder.getStatus()).toBe('starting')
    expect(FakeMediaRecorder.instances).toHaveLength(0)
    const staleTracks = h.media.sessions[0].tracks
    expect(staleTracks.map((track) => track.readyState)).toEqual([
      'ended',
      'ended',
    ])
    expect(staleTracks.map((track) => track.stopCalls)).toEqual([1, 1])

    h.media.grant()
    await h.flush()
    expect(h.recorder.getStatus()).toBe('preview')
    const nextStream = h.media.sessions[1].stream
    expect(nextStream.getTracks().map((track) => track.kind)).toEqual(['video'])

    h.recorder.confirmStart()
    expect(h.recorder.getStatus()).toBe('recording')
    expect(h.recorder.getActiveStream()).toBe(nextStream)
    expect(FakeMediaRecorder.instances).toHaveLength(1)
  })

  it('预检期间轨道提前结束：回 idle、报 start-failed、不产生 recorder/take，也不触碰历史 take', async () => {
    const h = makeHarness()

    // 先保存一条历史 take，随后的预检失败绝不能改变它。
    h.recorder.beginPreflight({ mode: 'video-only' })
    await h.flush()
    h.recorder.confirmStart()
    const oldRecorder = h.lastRecorder()
    oldRecorder.emitData(['history'])
    h.recorder.stop()
    oldRecorder.emitStop()
    expect(h.takes).toHaveLength(1)

    h.recorder.beginPreflight({ mode: 'av' })
    await h.flush()
    expect(h.recorder.getStatus()).toBe('preview')
    const [videoTrack, audioTrack] = h.sessions[1].tracks

    videoTrack.emitEnded()
    expect(h.recorder.getStatus()).toBe('idle')
    expect(h.errors[0]?.code).toBe('start-failed')
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    expect(h.takes).toHaveLength(1)
    expect(h.takes[0].blob).toBeTruthy()
    // 已 ended 轨道不会被重复 stop；另一条仍 live 的轨道必须释放一次。
    expect(videoTrack.readyState).toBe('ended')
    expect(audioTrack.readyState).toBe('ended')
    expect(audioTrack.stopCalls).toBe(1)

    // 另一条轨道的迟到事件不能再改变结局。
    audioTrack.emitEnded()
    expect(h.errors).toHaveLength(1)
    expect(h.takes).toHaveLength(1)
  })

  it('确认开拍时录制器构造失败：释放预检流、回 idle、不产生 take，历史 take 保留，可取流重试', async () => {
    const h = makeHarness()
    h.recorder.beginPreflight({ mode: 'video-only' })
    await h.flush()
    h.recorder.confirmStart()
    const oldRecorder = h.lastRecorder()
    oldRecorder.emitData(['history'])
    h.recorder.stop()
    oldRecorder.emitStop()

    h.recorder.beginPreflight()
    await h.flush()
    const stream = h.sessions[1].stream

    FakeMediaRecorder.ctorThrows = new Error('ctor boom')
    h.recorder.confirmStart()

    expect(h.recorder.getStatus()).toBe('idle')
    expect(h.errors[0]?.code).toBe('start-failed')
    expect(h.takes).toHaveLength(1)
    expect(
      stream.getTracks().map((track) => (track as FakeTrack).stopCalls),
    ).toEqual([1, 1])

    FakeMediaRecorder.ctorThrows = null
    h.recorder.beginPreflight({ mode: 'video-only' })
    await h.flush()
    h.recorder.confirmStart()
    expect(h.recorder.getStatus()).toBe('recording')
    expect(FakeMediaRecorder.instances).toHaveLength(2)
  })

  it('确认开拍时 recorder.start 失败：同一条预检流只释放一次', async () => {
    const h = makeHarness()
    h.recorder.beginPreflight()
    await h.flush()
    const stream = h.sessions[0].stream

    FakeMediaRecorder.startThrows = new DOMException('start failed', 'InvalidStateError')
    h.recorder.confirmStart()

    expect(h.recorder.getStatus()).toBe('idle')
    expect(h.errors[0]?.code).toBe('start-failed')
    expect(h.takes).toHaveLength(0)
    expect(
      stream.getTracks().map((track) => (track as FakeTrack).stopCalls),
    ).toEqual([1, 1])
  })
})
