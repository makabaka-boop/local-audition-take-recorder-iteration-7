import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  MARKER_LABEL_MAX_LENGTH,
  STOP_FINALIZE_GRACE_MS,
  freezeTakeMarkers,
  type AddMarkerResult,
  type Take,
  type TakeMarker,
} from '../recorder/CaptureRecorder'
import { FakeMediaRecorder } from '../test/fakes'
import { makeHarness, readBlob, type Harness } from '../test/harness'

/**
 * 瞬间标记内核测试：
 * - 只在 recording 且未冻结停止时写入；暂停/等待权限/停止中/已结束明确拒绝
 * - 时间戳取排除暂停的有效时钟，暂停边界不漂移
 * - 同毫秒多次标记按创建次序（order）保留
 * - 停止成功后标记随 Blob/时长冻结；停止超时与设备中断按冻结时长裁剪
 * - 空 Blob 不生成带标记 take；旧会话迟到事件/调用不附到新 take
 * - stop/dataavailable 乱序下标记与成片一致
 */
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

function markOk(h: Harness, label: string): TakeMarker {
  const result = h.recorder.addMarker(label)
  expect(result.ok).toBe(true)
  return (result as Extract<AddMarkerResult, { ok: true }>).marker
}

function expectRejected(result: AddMarkerResult, reason: string): void {
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.reason).toBe(reason)
    expect(result.message.length).toBeGreaterThan(0)
  }
}

function stopAndFreeze(h: Harness, rec = h.lastRecorder()): Take {
  h.recorder.stop()
  rec.emitStop()
  expect(h.takes).toHaveLength(1)
  return h.takes[0]
}

describe('瞬间标记：写入窗口与时间戳', () => {
  it('录制中写入标记：时间取排除暂停的有效时钟，标签被 trim，并经 onMarker 回调', async () => {
    const h = makeHarness()
    const rec = await startTake(h) // 有效时钟起点 1000

    h.clock.now = 2400
    const marker = markOk(h, '  精彩表情  ')
    expect(marker.label).toBe('精彩表情')
    expect(marker.timeMs).toBe(1400) // 2400 - 1000
    expect(marker.order).toBe(0)
    expect(h.liveMarkers).toEqual([marker])

    rec.emitData(['d'])
    const take = stopAndFreeze(h, rec)
    expect(take.markers).toEqual([
      { label: '精彩表情', timeMs: 1400, order: 0 },
    ])
  })

  it('暂停边界：暂停期间有效时钟不增长，暂停前后的标记落在各自录制段', async () => {
    const h = makeHarness()
    const rec = await startTake(h) // 1000

    h.clock.advance(1000) // → 2000，有效 1000
    markOk(h, '暂停前') // 1000

    h.recorder.pause()
    h.clock.advance(5000) // 暂停 5000：有效时钟冻结在 1000
    expectRejected(h.recorder.addMarker('暂停中偷写'), 'paused')

    h.recorder.resume()
    h.clock.advance(1500) // 继续段 1500，累计 2500
    markOk(h, '继续后') // 2500

    rec.emitData(['d'])
    const take = stopAndFreeze(h, rec)
    expect(take.durationMs).toBe(2500)
    expect(take.markers.map((m) => [m.label, m.timeMs])).toEqual([
      ['暂停前', 1000],
      ['继续后', 2500],
    ])
  })

  it('多段暂停/继续后停止：标记时间只累计各录制段', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    h.clock.advance(800)
    markOk(h, 'm1') // 800
    h.recorder.pause()
    h.clock.advance(4000)
    h.recorder.resume()
    h.clock.advance(1200)
    markOk(h, 'm2') // 2000
    h.recorder.pause()
    h.clock.advance(6000)
    h.recorder.resume()
    h.clock.advance(300)
    markOk(h, 'm3') // 2300

    rec.emitData(['d'])
    const take = stopAndFreeze(h, rec)
    expect(take.durationMs).toBe(2300)
    expect(take.markers.map((m) => m.timeMs)).toEqual([800, 2000, 2300])
  })
})

describe('瞬间标记：不可写入状态给出明确提示', () => {
  it('idle（未开拍 / 已结束）：not-recording，且不产生标记', async () => {
    const h = makeHarness()
    expectRejected(h.recorder.addMarker('还没开始'), 'not-recording')

    const rec = await startTake(h)
    rec.emitData(['d'])
    stopAndFreeze(h, rec)
    expect(h.recorder.getStatus()).toBe('idle')

    expectRejected(h.recorder.addMarker('结束后补标'), 'not-recording')
    expect(h.takes[0].markers).toEqual([])
  })

  it('starting（等待权限）：starting 拒绝；授权通过后可写', async () => {
    const h = makeHarness({ manualPermissions: true })
    h.recorder.start({ mode: 'av' })
    expect(h.recorder.getStatus()).toBe('starting')
    expectRejected(h.recorder.addMarker('授权还没回来'), 'starting')

    h.media.grant()
    await h.flush()
    const rec = h.lastRecorder()
    markOk(h, '开拍了')
    rec.emitData(['d'])
    const take = stopAndFreeze(h, rec)
    expect(take.markers.map((m) => m.label)).toEqual(['开拍了'])
  })

  it('paused：paused；resume 后恢复可写', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    h.recorder.pause()
    expectRejected(h.recorder.addMarker('暂停中'), 'paused')
    h.recorder.resume()
    markOk(h, '继续后')
    rec.emitData(['d'])
    const take = stopAndFreeze(h, rec)
    expect(take.markers).toHaveLength(1)
  })

  it('stopping（正在收尾，含封装等待）：stopping，标记冻结不再接受', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    markOk(h, '停止前')
    rec.emitData(['d'])
    h.recorder.stop()
    expect(h.recorder.getStatus()).toBe('stopping')
    expectRejected(h.recorder.addMarker('停止中'), 'stopping')
    expectRejected(h.recorder.addMarker('再点一次'), 'stopping')
    rec.emitStop()
    expect(h.takes[0].markers.map((m) => m.label)).toEqual(['停止前'])
  })

  it('空标签/纯空白/超长：拒绝且不写入；trim 后恰为上限可写', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    expectRejected(h.recorder.addMarker(''), 'label-blank')
    expectRejected(h.recorder.addMarker('   \n\t '), 'label-blank')
    expectRejected(
      h.recorder.addMarker('字'.repeat(MARKER_LABEL_MAX_LENGTH + 1)),
      'label-too-long',
    )
    const boundary = '字'.repeat(MARKER_LABEL_MAX_LENGTH)
    const marker = markOk(h, `  ${boundary}  `)
    expect(marker.label).toBe(boundary)
    rec.emitData(['d'])
    const take = stopAndFreeze(h, rec)
    expect(take.markers.map((m) => m.label)).toEqual([boundary])
  })

  it('dispose 后写入被拒绝，不会把标记写到任何 take', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    markOk(h, '生前')
    h.recorder.dispose()
    expectRejected(h.recorder.addMarker('卸载后'), 'not-recording')
    rec.emitData(['late'])
    rec.emitStop()
    expect(h.takes).toHaveLength(0)
  })

  it('被拒绝的写入既不触发 onMarker，也不产生 CaptureError', async () => {
    const h = makeHarness()
    await startTake(h)
    h.recorder.pause()
    expectRejected(h.recorder.addMarker('x'), 'paused')
    expect(h.liveMarkers).toEqual([])
    expect(h.errors).toEqual([])
  })
})

describe('瞬间标记：同毫秒创建次序', () => {
  it('同一毫秒连续写入多条：order 递增，冻结后按 (timeMs, order) 保留', async () => {
    const h = makeHarness()
    const rec = await startTake(h) // 1000
    h.clock.now = 3000 // 有效 2000
    const a = markOk(h, '甲')
    const b = markOk(h, '乙')
    const c = markOk(h, '丙')
    expect([a.order, b.order, c.order]).toEqual([0, 1, 2])
    expect(a.timeMs).toBe(2000)

    rec.emitData(['d'])
    const take = stopAndFreeze(h, rec)
    expect(take.markers.map((m) => m.label)).toEqual(['甲', '乙', '丙'])
    expect(take.markers.map((m) => m.order)).toEqual([0, 1, 2])
    expect(take.markers.every((m) => m.timeMs === 2000)).toBe(true)
  })

  it('freezeTakeMarkers：裁剪越界标记、按 (timeMs, order) 排序、不改入参', () => {
    const source: TakeMarker[] = [
      { label: '晚', timeMs: 4000, order: 0 },
      { label: '同毫秒-先', timeMs: 2000, order: 0 },
      { label: '同毫秒-后', timeMs: 2000, order: 1 },
      { label: '早', timeMs: 1000, order: 5 },
      { label: '越界', timeMs: 5000, order: 0 },
    ]
    const frozen = freezeTakeMarkers(source, 4000)
    expect(frozen.map((m) => m.label)).toEqual([
      '早',
      '同毫秒-先',
      '同毫秒-后',
      '晚',
    ])
    expect(frozen.map((m) => [m.timeMs, m.order])).toEqual([
      [1000, 5],
      [2000, 0],
      [2000, 1],
      [4000, 0],
    ])
    // 入参不被修改（顺序/内容原样）
    expect(source.map((m) => m.label)).toEqual([
      '晚',
      '同毫秒-先',
      '同毫秒-后',
      '早',
      '越界',
    ])
    // 冻结结果是副本：改冻结数组不影响再次冻结
    frozen.length = 0
    expect(freezeTakeMarkers(source, 4000)).toHaveLength(4)
  })
})

describe('瞬间标记：随成片冻结，空 Blob 不生成带标记 take', () => {
  it('用户正常停止：标记与 Blob、时长一同冻结', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    h.clock.advance(900)
    markOk(h, '点一')
    rec.emitData(['chunk-1'])
    h.clock.advance(100)
    markOk(h, '点二')
    rec.emitData(['chunk-2'])

    const take = stopAndFreeze(h, rec)
    expect(take.durationMs).toBe(1000)
    expect(await readBlob(take.blob)).toBe('chunk-1\nchunk-2\n')
    expect(take.markers.map((m) => [m.label, m.timeMs])).toEqual([
      ['点一', 900],
      ['点二', 1000],
    ])
  })

  it('全程空数据（零字节 chunk）：empty-take 失败，标记随会话丢弃', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    markOk(h, '空片里的标记')
    markOk(h, '又一条')
    rec.emitEmptyData()
    rec.emitEmptyData()
    h.recorder.stop()
    rec.emitStop()

    expect(h.takes).toHaveLength(0)
    expect(h.errors[0]?.code).toBe('empty-take')
  })

  it('无数据设备中断：不产生成片，标记不落任何 take', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    markOk(h, '中断前')
    h.sessions[0].tracks[0].emitEnded()
    rec.emitStop()
    expect(h.takes).toHaveLength(0)
    expect(h.errors[0]?.code).toBe('empty-take')
  })

  it('停止成功后实时镜像清空（标记只活在 Take.markers），onMarker 回调也不再增长', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    markOk(h, 'x')
    expect(h.recorder.getLiveMarkers()).toHaveLength(1)
    rec.emitData(['d'])
    stopAndFreeze(h, rec)
    expect(h.recorder.getLiveMarkers()).toEqual([])
    const callbacksAfterStop = h.liveMarkers.length
    expectRejected(h.recorder.addMarker('结束后'), 'not-recording')
    expect(h.liveMarkers).toHaveLength(callbacksAfterStop)
  })
})

describe('瞬间标记：停止超时与设备中断按冻结有效时长裁剪', () => {
  it('设备中断：时长冻结在中断时刻，stop/dataavailable 乱序下尾段与标记各得其所', async () => {
    const h = makeHarness()
    const rec = await startTake(h) // 1000
    h.clock.advance(1200) // → 2200
    markOk(h, '中断前一刻') // 1200
    rec.emitData(['pre'])

    h.sessions[0].tracks[0].emitEnded()
    expect(h.recorder.getStatus()).toBe('stopping')
    expectRejected(h.recorder.addMarker('中断后'), 'stopping')

    // stop 先到 → 成片落定；其后晚到的尾段 chunk 必须丢弃
    rec.emitStop()
    expect(h.takes).toHaveLength(1)
    rec.emitData(['late-tail'])

    const take = h.takes[0]
    expect(take.reason).toBe('device-interrupted')
    expect(take.durationMs).toBe(1200)
    expect(take.markers.map((m) => [m.label, m.timeMs])).toEqual([
      ['中断前一刻', 1200],
    ])
    expect(await readBlob(take.blob)).toBe('pre\n')
  })

  it('设备中断但尾段在 stop 之前晚到：尾段并入，标记仍冻结在中断时刻', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    h.clock.advance(900)
    markOk(h, '点')
    rec.emitData(['head'])
    h.sessions[0].tracks[0].emitEnded()
    h.clock.advance(STOP_FINALIZE_GRACE_MS - 50)
    rec.emitData(['tail']) // stop 之前晚到：并入
    rec.emitStop()

    const take = h.takes[0]
    expect(take.reason).toBe('device-interrupted')
    expect(take.durationMs).toBe(900)
    expect(await readBlob(take.blob)).toBe('head\ntail\n')
    expect(take.markers.map((m) => m.timeMs)).toEqual([900])
  })

  it('停止超时（编码器不发 stop）：兜底按冻结时长成片并冻结标记，封装等待不计入', async () => {
    const h = makeHarness()
    const rec = await startTake(h) // 1000
    h.clock.advance(1500)
    markOk(h, '超时停止前') // 1500
    rec.emitData(['captured'])
    h.recorder.stop()
    expect(h.recorder.getStatus()).toBe('stopping')
    expectRejected(h.recorder.addMarker('封装等待中'), 'stopping')

    h.clock.advance(STOP_FINALIZE_GRACE_MS + 4000)
    expect(h.recorder.getStatus()).toBe('idle')
    expect(h.takes).toHaveLength(1)
    const take = h.takes[0]
    expect(take.durationMs).toBe(1500)
    expect(take.markers).toEqual([
      { label: '超时停止前', timeMs: 1500, order: 0 },
    ])
    expect(await readBlob(take.blob)).toBe('captured\n')
    expect(h.clock.pendingCount).toBe(0)
  })

  it('恰在冻结时刻的标记保留（timeMs <= durationMs 边界包含）', async () => {
    const h = makeHarness()
    const rec = await startTake(h) // 1000
    h.clock.now = 2000
    markOk(h, '界内') // 1000
    h.recorder.pause() // accumulatedMs 冻结在 1000
    h.clock.advance(9999) // 暂停多久都不影响
    h.recorder.stop() // 暂停态停止：冻结时长 = 1000
    rec.emitData(['d'])
    rec.emitStop()
    const take = h.takes[0]
    expect(take.durationMs).toBe(1000)
    expect(take.markers.map((m) => m.label)).toEqual(['界内'])
  })
})

describe('瞬间标记：会话隔离（切换 take 不串标记）', () => {
  it('旧 take 迟到的 recorder 事件绝不把标记附到新 take，新会话实时镜像从空开始', async () => {
    const h = makeHarness()
    const rec1 = await startTake(h)
    markOk(h, '第一条')
    rec1.emitData(['one'])
    h.recorder.stop()
    rec1.emitStop()
    expect(h.takes).toHaveLength(1)
    expect(h.liveMarkers).toHaveLength(1)

    const rec2 = await startTake(h)
    expect(rec2).not.toBe(rec1)
    // 新会话：实时镜像已随 starting 重置（内核层面 getLiveMarkers 为空）
    expect(h.recorder.getLiveMarkers()).toEqual([])
    // 旧 recorder 在新会话中重放事件：会话守卫丢弃
    rec1.emitData(['ghost'])
    rec1.emitStop()

    markOk(h, '第二条')
    rec2.emitData(['two'])
    h.recorder.stop()
    rec2.emitStop()

    expect(h.takes).toHaveLength(2)
    expect(h.takes[0].markers.map((m) => m.label)).toEqual(['第一条'])
    expect(h.takes[1].markers.map((m) => m.label)).toEqual(['第二条'])
    expect(await readBlob(h.takes[0].blob)).toBe('one\n')
    expect(await readBlob(h.takes[1].blob)).toBe('two\n')
  })

  it('连续三条 take：标记序号各自从 0 开始，互不串扰', async () => {
    const h = makeHarness()
    for (let i = 0; i < 3; i++) {
      const rec = await startTake(h)
      h.clock.advance(500)
      markOk(h, `take${i + 1}-a`)
      h.clock.advance(500)
      markOk(h, `take${i + 1}-b`)
      rec.emitData([`data${i + 1}`])
      h.recorder.stop()
      rec.emitStop()
      expect(h.recorder.getStatus()).toBe('idle')
    }

    expect(h.takes).toHaveLength(3)
    for (let i = 0; i < 3; i++) {
      const take = h.takes[i]
      expect(take.markers.map((m) => m.order)).toEqual([0, 1])
      expect(take.markers.map((m) => m.label)).toEqual([
        `take${i + 1}-a`,
        `take${i + 1}-b`,
      ])
      expect(take.markers.map((m) => m.timeMs)).toEqual([500, 1000])
    }
  })

  it('设备中断成片后重录：中断 take 的标记不进入重录 take', async () => {
    const h = makeHarness()
    const rec1 = await startTake(h)
    h.clock.advance(700)
    markOk(h, '中断条')
    rec1.emitData(['before-pull'])
    h.sessions[0].tracks[0].emitEnded()
    rec1.emitStop()
    expect(h.takes[0].reason).toBe('device-interrupted')
    expect(h.takes[0].markers.map((m) => m.label)).toEqual(['中断条'])

    const rec2 = await startTake(h)
    expect(h.recorder.getLiveMarkers()).toEqual([])
    markOk(h, '重录条')
    rec2.emitData(['retry'])
    h.recorder.stop()
    rec2.emitStop()

    expect(h.takes).toHaveLength(2)
    expect(h.takes[0].markers.map((m) => m.label)).toEqual(['中断条'])
    expect(h.takes[1].markers.map((m) => m.label)).toEqual(['重录条'])
  })

  it('授权等待取消后重录：被取消会话不允许写入，重录实时镜像从空开始', async () => {
    const h = makeHarness({ manualPermissions: true })
    h.recorder.start({ mode: 'av' })
    expectRejected(h.recorder.addMarker('等授权'), 'starting')
    h.recorder.stop() // 取消本次开拍
    expect(h.recorder.getStatus()).toBe('idle')
    h.media.grant() // 迟到授权
    await h.flush()
    expect(FakeMediaRecorder.instances).toHaveLength(0)

    h.recorder.start({ mode: 'av' })
    h.media.grant()
    await h.flush()
    const rec = h.lastRecorder()
    expect(h.recorder.getLiveMarkers()).toEqual([])
    markOk(h, '重录')
    rec.emitData(['retry'])
    h.recorder.stop()
    rec.emitStop()
    expect(h.takes).toHaveLength(1)
    expect(h.takes[0].markers.map((m) => m.label)).toEqual(['重录'])
  })
})
