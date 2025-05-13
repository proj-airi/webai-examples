import type { ProgressInfo } from '@xsai-transformers/shared/types'

export enum MessageStatus {
  Loading = 'loading',
  Ready = 'ready',
}

export type { ProgressInfo }

export interface WorkerMessageBaseEvent<T, D> {
  data: D
  type: T
}

export type WorkerMessageEvent = {
  [K in keyof WorkerMessageEvents]: WorkerMessageBaseEvent<K, WorkerMessageEvents[K]>;
}[keyof WorkerMessageEvents]

export interface WorkerMessageEvents {
  error: {
    error?: unknown
    message?: string
  }
  process: {
    instruction: string
    imageBuffer: Uint8ClampedArray | Uint8Array
    imageWidth: number
    imageHeight: number
    channels: 1 | 2 | 3 | 4
  }
  processResult: {
    input: {
      instruction: string
      imageBuffer: Uint8ClampedArray | Uint8Array
      imageWidth: number
      imageHeight: number
      channels: 1 | 2 | 3 | 4
    }
    output: {
      data: string
    }
  }
  info: {
    message: string
  }
  load: undefined
  progress: {
    progress: ProgressInfo
  }
  status: {
    message?: string
    status: MessageStatus
  }
}
