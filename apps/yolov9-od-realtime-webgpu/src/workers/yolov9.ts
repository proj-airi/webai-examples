import type { LoadOptionProgressCallback, LoadOptions } from '@xsai-transformers/shared/types'
import type { Load, Process, ProcessResult } from './types'

import { createTransformersWorker } from '@xsai-transformers/shared/worker'

export function createYoloV9Worker<T extends LoadOptions<object>>(createOptions: { baseURL?: string }) {
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
    return res.data.filter(item => item.score > (process?.threshold || 0.1))
  }

  return {
    load,
    process,
    dispose: () => worker?.dispose(),
  }
}

export type VLMWorker = ReturnType<typeof createYoloV9Worker>
