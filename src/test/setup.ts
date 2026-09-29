/**
 * Vitest 全局环境补齐：
 * 1. jsdom 的 Blob 不支持把 Blob 作为 BlobPart 嵌套合并（会序列化成
 *    "[object Blob]"），而录制器正是用 new Blob(chunks) 合并尾段。
 *    这里替换为 Node 实现的 Blob（支持嵌套与 .text()）。
 * 2. jsdom 没有 URL.createObjectURL，给一个内存记账替身。
 */
import { Blob as NodeBlob } from 'node:buffer'

;(globalThis as { Blob?: typeof Blob }).Blob =
  NodeBlob as unknown as typeof Blob

interface FakeObjectStore {
  blobs: Map<string, Blob>
  seq: number
}

const store: FakeObjectStore = { blobs: new Map(), seq: 0 }

class FakeURL {
  static createObjectURL(blob: Blob): string {
    const url = `blob:fake/${++store.seq}`
    store.blobs.set(url, blob)
    return url
  }

  static revokeObjectURL(url: string): void {
    store.blobs.delete(url)
  }
}

export const objectStore = store

;(globalThis as { URL?: typeof URL }).URL =
  FakeURL as unknown as typeof URL

// matchMedia 占位（部分 UI 库需要，本项目保持轻量）
if (!('matchMedia' in globalThis)) {
  ;(globalThis as { matchMedia?: unknown }).matchMedia = () => ({
    matches: false,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })
}
