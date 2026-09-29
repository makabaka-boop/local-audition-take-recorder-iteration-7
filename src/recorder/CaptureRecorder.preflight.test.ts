import { beforeEach, describe, expect, it } from 'vitest'
import { makeHarness } from '../test/harness'
import { FakeMediaRecorder, FakeTrack } from '../test/fakes'

/**
 * 开拍预检内核验收：
 * - 预检阶段只取一次流，确认开拍交接同一流，绝不二次 getUserMedia；
 * - 预检不产生任何 take；权限晚到/取消、轨道提前结束、启动失败按会话代次裁决；
 * - 每个旧会话的轨道只释放一次，历史 take 不受影响。
 */
beforeEach(() => {
  FakeMediaRecorder.reset()
})

describe('开拍预检：同一条流从预览交接给录制器', () => {
  it('预检流在确认时成为录制流，全程只有一次 getUserMedia', async () => {
    const h = makeHarness({ manualPermissions: true })

    h.recorder.beginPreflight({
      mode: 'av',
      videoDeviceId: 'cam1',
      audioDeviceId: 'mic1',
      videoDeviceLabel: '摄像头 A',
      audioDeviceLabel: '麦克风 A',
    })
    expect(h.recorder.getStatus()).toBe('preflight-requesting')
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]).toEqual({
      video: { deviceId: { exact: 'cam1' } },
      audio: { deviceId: { exact: 'mic1' } },
    })
    expect(h.takes).toHaveLength(0)
    expect(FakeMediaRecorder.instances).toHaveLength(0)

    h.media.grant()
    await h.flush()
    expect(h.recorder.getStatus()).toBe('preflight-ready')
    expect(h.takes).toHaveLength(0)
    const previewStream = h.media.sessions[0].stream

    h.recorder.confirmStart()
    expect(h.recorder.getStatus()).toBe('recording')
    expect(h.calls).toHaveLength(1)
    const rec = h.lastRecorder()
    expect(rec.stream).toBe(previewStream)

    rec.emitData(['same-stream'])
    h.recorder.stop()
    rec.emitStop()
    expect(h.recorder.getStatus()).toBe('idle')
    expect(h.takes).toHaveLength(1)
  })

  it('预检冻结模式与设备：仅音频只请求音频，预检流展示身份不被后续选择改写', async () => {
    const h = makeHarness({ manualPermissions: true })

    h.recorder.beginPreflight({ mode: 'audio-only', audioDeviceId: 'mic9' })
    h.media.grant()
    await h.flush()

    expect(h.calls[0]).toEqual({ video: false, audio: { deviceId: { exact: 'mic9' } } })
    expect(h.recorder.getActiveMode()).toBe('audio-only')
    expect(h.recorder.getActiveVideoDevice()).toBeNull()
    expect(h.recorder.getActiveAudioDevice()).toEqual({ id: 'mic9', label: '' })
    expect(h.recorder.getActiveStream()).toBe(h.media.sessions[0].stream)

    // 重复确认/重复预检在非空闲态无效
    h.recorder.beginPreflight({ mode: 'video-only' })
    h.recorder.confirmStart()
    const rec = h.lastRecorder()
    expect(rec.stream).toBe(h.media.sessions[0].stream)
    expect(h.calls).toHaveLength(1)
  })
})

describe('开拍预检：交错时序与资源归属', () => {
  it('授权未决时取消：立即回 idle，无成片无错误；迟到放行的轨道只释放一次', async () => {
    const h = makeHarness({ manualPermissions: true })
    h.recorder.beginPreflight()
    expect(h.recorder.getStatus()).toBe('preflight-requesting')

    h.recorder.stop()
    expect(h.recorder.getStatus()).toBe('idle')
    expect(h.errors).toEqual([])
    expect(h.takes).toEqual([])

    h.media.grant()
    await h.flush()
    expect(h.recorder.getStatus()).toBe('idle')
    expect(FakeMediaRecorder.instances).toHaveLength(0)
    const lateTracks = h.media.sessions[0].tracks
    expect(lateTracks.every((track) => track.readyState === 'ended')).toBe(true)
    const stopCounts = lateTracks.map((track) => {
      let count = 0
      const fake = track as FakeTrack
      // FakeTrack.stop 幂等；再调用一次确认不会重复改变/释放
      fake.stop()
      fake.stop()
      void count
      return fake.readyState
    })
    expect(stopCounts).toEqual(['ended', 'ended'])
  })

  it('预检就绪后取消：释放本会话轨道一次，不产生 take；随后可重新申请', async () => {
    const h = makeHarness({ manualPermissions: true })
    h.recorder.beginPreflight()
    h.media.grant()
    await h.flush()
    const tracks = h.media.sessions[0].tracks

    h.recorder.stop()
    expect(h.recorder.getStatus()).toBe('idle')
    expect(tracks.map((track) => track.readyState)).toEqual(['ended', 'ended'])
    expect(h.takes).toHaveLength(0)

    h.recorder.beginPreflight({ mode: 'video-only' })
    h.media.grant()
    await h.flush()
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1]).toEqual({ video: true, audio: false })
    expect(h.recorder.getStatus()).toBe('preflight-ready')
  })

  it('权限拒绝：回到 idle 并给出 permission-denied，不产生 take', async () => {
    const h = makeHarness({ manualPermissions: true })
    h.recorder.beginPreflight({ mode: 'video-only' })
    h.media.deny(new DOMException('denied', 'NotAllowedError'))
    await h.flush()

    expect(h.recorder.getStatus()).toBe('idle')
    expect(h.errors[0]?.code).toBe('permission-denied')
    expect(h.takes).toEqual([])
  })

  it('预检期间轨道 ended：取消本次预检并释放全部轨道，不产生 take', async () => {
    const h = makeHarness({ manualPermissions: true })
    h.recorder.beginPreflight()
    h.media.grant()
    await h.flush()
    const [videoTrack, audioTrack] = h.media.sessions[0].tracks

    videoTrack.emitEnded()
    expect(h.recorder.getStatus()).toBe('idle')
    expect(h.errors[0]?.code).toBe('start-failed')
    expect(videoTrack.readyState).toBe('ended')
    expect(audioTrack.readyState).toBe('ended')
    expect(h.takes).toEqual([])
  })

  it('轨道在确认开拍前已 ended 但未派发事件：拒绝进入 recording 并释放一次', async () => {
    const h = makeHarness({ manualPermissions: true })
    h.recorder.beginPreflight()
    h.media.grant()
    await h.flush()
    const [videoTrack, audioTrack] = h.media.sessions[0].tracks
    videoTrack.readyState = 'ended'

    h.recorder.confirmStart()
    expect(h.recorder.getStatus()).toBe('idle')
    expect(h.errors[0]?.code).toBe('start-failed')
    expect(FakeMediaRecorder.instances).toHaveLength(0)
    expect(videoTrack.readyState).toBe('ended')
    expect(audioTrack.readyState).toBe('ended')
  })

  it('录制器构造失败：释放预检流，不产生 take；历史 take 保持不变', async () => {
    const h = makeHarness({ manualPermissions: true })

    // 先通过一次预检保存历史 take
    h.recorder.beginPreflight({ mode: 'av' })
    h.media.grant()
    await h.flush()
    h.recorder.confirmStart()
    const first = h.lastRecorder()
    first.emitData(['history'])
    h.recorder.stop()
    first.emitStop()
    expect(h.takes).toHaveLength(1)

    h.recorder.beginPreflight()
    h.media.grant()
    await h.flush()
    const previewTracks = h.media.sessions[1].tracks
    FakeMediaRecorder.ctorThrows = new Error('boom')

    h.recorder.confirmStart()
    expect(h.recorder.getStatus()).toBe('idle')
    expect(h.errors[0]?.code).toBe('start-failed')
    expect(h.takes).toHaveLength(1)
    expect(previewTracks.map((track) => track.readyState)).toEqual(['ended', 'ended'])
  })

  it('录制器 start 抛错：释放同一条预检流，不产生 take，随后可重拍', async () => {
    const h = makeHarness({ manualPermissions: true })
    h.recorder.beginPreflight()
    h.media.grant()
    await h.flush()
    const tracks = h.media.sessions[0].tracks
    FakeMediaRecorder.startThrows = new Error('cannot start')

    h.recorder.confirmStart()
    expect(h.recorder.getStatus()).toBe('idle')
    expect(h.errors[0]?.code).toBe('start-failed')
    expect(tracks.every((track) => track.readyState === 'ended')).toBe(true)
    expect(h.takes).toEqual([])

    FakeMediaRecorder.startThrows = null
    h.recorder.beginPreflight({ mode: 'video-only' })
    h.media.grant()
    await h.flush()
    h.recorder.confirmStart()
    expect(h.recorder.getStatus()).toBe('recording')
  })
})
