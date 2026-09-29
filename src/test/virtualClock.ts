/**
 * 虚拟时钟 + 虚拟定时器队列：
 * 测试用它同时驱动 CaptureRecorder 的 now() 与停止兜底定时器，
 * 从而在不依赖真实时间的前提下，精确断言“封装等待 / 无结束事件”的结局。
 *
 * - nowMs：当前虚拟时间（毫秒），由测试直接赋值或 advance() 推进
 * - setTimer/clearTimer：与 RecorderDeps 对齐的定时器面
 * - advance(ms)：推进时钟并同步触发所有到期回调（含同一时刻、
 *   以及回调中新注册且已到期的定时器）；不清空微任务，需要时配合
 *   await Promise.resolve() 使用
 */

export interface VirtualClock {
  nowMs: number
  /** now 的读写别名（兼容既有测试的 h.clock.now 赋值） */
  now: number
  /** 仍挂起的定时器数量（断言无悬挂定时器用） */
  readonly pendingCount: number
  setTimer: (handler: () => void, timeoutMs: number) => unknown
  clearTimer: (handle: unknown) => void
  /** 推进虚拟时间并触发到期回调 */
  advance: (ms: number) => void
  /** 只触发当前时刻已到期的回调（不推进时间） */
  runDue: () => void
}

interface TimerEntry {
  id: number
  dueAt: number
  handler: () => void
  cancelled: boolean
}

export function createVirtualClock(start = 1000): VirtualClock {
  let seq = 0
  const queue: TimerEntry[] = []

  const setTimer = (handler: () => void, timeoutMs: number) => {
    const entry: TimerEntry = {
      id: ++seq,
      dueAt: clock.nowMs + Math.max(0, timeoutMs),
      handler,
      cancelled: false,
    }
    queue.push(entry)
    return entry.id
  }

  const clearTimer = (handle: unknown) => {
    const entry = queue.find((t) => t.id === handle)
    if (entry) entry.cancelled = true
  }

  const runDue = () => {
    // 循环到不再有到期项：回调内新注册、且 dueAt <= now 的定时器也立即触发
    for (;;) {
      const due = queue
        .filter((t) => !t.cancelled && t.dueAt <= clock.nowMs)
        .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)
      if (due.length === 0) break
      for (const entry of due) {
        if (entry.cancelled) continue
        entry.cancelled = true
        entry.handler()
      }
    }
    // 清理已消费/已取消的句柄，保持 pendingCount 语义为“仍挂起”
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].cancelled) queue.splice(i, 1)
    }
  }

  const clock: VirtualClock = {
    nowMs: start,
    get now() {
      return clock.nowMs
    },
    set now(value: number) {
      clock.nowMs = value
    },
    get pendingCount() {
      return queue.filter((t) => !t.cancelled).length
    },
    setTimer,
    clearTimer,
    advance(ms: number) {
      clock.nowMs += ms
      runDue()
    },
    runDue,
  }

  return clock
}
