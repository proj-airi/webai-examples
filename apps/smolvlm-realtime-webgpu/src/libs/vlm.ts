import type { LoadOptionProgressCallback, LoadOptions } from '@xsai-transformers/shared/types'

import { createTransformersWorker } from '@xsai-transformers/shared/worker'

export interface Process {
  instruction: string
  imageBuffer: Uint8ClampedArray | Uint8Array
  imageWidth: number
  imageHeight: number
  channels: 1 | 2 | 3 | 4
}

export interface ProcessResult {
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

export interface Load<T = object> {
  options?: LoadOptions<T>
}

export function createVLMWorker<
  T extends LoadOptions<object>,
>(createOptions: { baseURL?: string }) {
  if (!createOptions.baseURL) {
    throw new Error('baseURL is required')
  }

  const worker = createTransformersWorker({ workerURL: createOptions.baseURL })
  const load = (options?: T) => {
    let onProgress: LoadOptionProgressCallback | undefined
    if (options && 'onProgress' in options && typeof options.onProgress === 'function') {
      onProgress = options.onProgress
      delete options.onProgress
    }

    return worker.load<Load>({ data: { options }, type: 'load' }, { onProgress })
  }

  const process = async (process: Process) => {
    const res = await worker.process<Process, ProcessResult>({ data: process, type: 'process' }, 'processResult')
    return res.output.data
  }

  return {
    load,
    process,
    dispose: () => worker?.dispose(),
  }
}

export type VLMWorker = ReturnType<typeof createVLMWorker>
