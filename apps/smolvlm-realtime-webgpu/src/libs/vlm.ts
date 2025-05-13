import type { LoadOptionProgressCallback } from '@xsai-transformers/shared/types'
import type { WorkerMessageEvent } from './types'

import workerURL from './worker?worker&url'

let worker: Worker | undefined
let isReady = false
let isLoading = false
let _options: {
  onProgress?: LoadOptionProgressCallback
}

export async function load(options: {
  onProgress?: LoadOptionProgressCallback
}) {
  _options = options

  return new Promise<void>((resolve, reject) => {
    if (isReady) {
      resolve()
      return
    }

    try {
      let onProgress: LoadOptionProgressCallback | undefined
      if (options != null && 'onProgress' in options && options.onProgress != null) {
        onProgress = options?.onProgress
        delete options?.onProgress
      }

      if (!isLoading && !isReady && !worker) {
        try {
          worker = new Worker(workerURL, { type: 'module' })

          if (!worker)
            throw new Error('Worker not initialized')

          worker.postMessage({ type: 'load', data: undefined } satisfies WorkerMessageEvent)
        }
        catch (err) {
          isLoading = false
          reject(err)
          return
        }

        worker.addEventListener('message', (event: MessageEvent<WorkerMessageEvent>) => {
          switch (event.data.type) {
            case 'error':
              isLoading = false
              reject(event.data.data.error)
              break
            case 'progress':
              if (onProgress != null && typeof onProgress === 'function') {
                onProgress(event.data.data.progress)
              }

              break
          }
        })
      }

      worker?.addEventListener('message', (event: MessageEvent<WorkerMessageEvent>) => {
        if (event.data.type !== 'status' || event.data.data.status !== 'ready')
          return

        isReady = true
        isLoading = false
        resolve()
      })
    }
    catch (err) {
      isLoading = false
      reject(err)
    }
  })
}

export async function process(input: {
  instruction: string
  imageBuffer: Uint8ClampedArray | Uint8Array
  imageWidth: number
  imageHeight: number
  channels: 1 | 2 | 3 | 4
}) {
  return new Promise<{ data: string }>((resolve, reject) => {
    load(_options).then(() => {
      if (!worker || !isReady) {
        reject(new Error('Model not loaded'))
        return
      }

      worker.addEventListener('error', (event: ErrorEvent) => {
        reject(event)
      })

      let errored = false
      let resultDone = false

      worker.addEventListener('message', (event: MessageEvent<WorkerMessageEvent>) => {
        switch (event.data.type) {
          case 'error':
            errored = true
            reject(event.data.data.error)
            break
          case 'processResult':
            resultDone = true
            resolve(event.data.data.output)

            break
        }
      })

      if (!errored && !resultDone) {
        worker.postMessage({
          data: {
            instruction: input.instruction,
            imageBuffer: input.imageBuffer,
            imageWidth: input.imageWidth,
            imageHeight: input.imageHeight,
            channels: input.channels,
          },
          type: 'process',
        } satisfies WorkerMessageEvent)
      }
    })
  })
}

export function dispose() {
  if (!(worker))
    return

  worker.terminate()
  isReady = false
  isLoading = false
  worker = undefined
}
