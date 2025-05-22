/* eslint-disable no-restricted-globals */
import type { ObjectDetectionPipeline } from '@huggingface/transformers'
import type { LoadMessageEvents, ProcessMessageEvents, WorkerMessageEvent } from '@xsai-transformers/shared/worker'
import type { Load, Process } from './types'

import { pipeline, RawImage } from '@huggingface/transformers'
import { isWebGPUSupported } from 'gpuu/webgpu'

let objectDetectionPipeline: ObjectDetectionPipeline | undefined

export enum MessageStatus {
  Loading = 'loading',
  Ready = 'ready',
}

async function process(imageBuffer: Uint8ClampedArray | Uint8Array, imageWidth: number, imageHeight: number, channels: 1 | 2 | 3 | 4) {
  const img = new RawImage(imageBuffer, imageWidth, imageHeight, channels)
  const detectionResult = await objectDetectionPipeline!(img, { threshold: 0.9 })

  self.postMessage({
    data: {
      input: {
        imageBuffer,
        imageWidth,
        imageHeight,
        channels,
      },
      output: { data: detectionResult },
    },
    type: 'processResult',
  } satisfies ProcessMessageEvents)
}

async function load(modelId: string) {
  try {
    const device = (await isWebGPUSupported()) ? 'webgpu' : 'wasm'

    self.postMessage({ data: { message: `Using device: "${device}"` }, type: 'info' } satisfies LoadMessageEvents)
    self.postMessage({ data: { message: 'Loading models...' }, type: 'info' } satisfies LoadMessageEvents)

    // eslint-disable-next-line ts/ban-ts-comment
    // @ts-ignore - Expression produces a union type that is too complex to represent.ts(2590)
    objectDetectionPipeline = await pipeline('object-detection', modelId, { device, progress_callback: progress => self.postMessage({ data: { progress }, type: 'progress' } satisfies LoadMessageEvents) })

    self.postMessage({ data: { message: 'Ready!', status: MessageStatus.Ready }, type: 'status' } satisfies LoadMessageEvents)
  }
  catch (err) {
    self.postMessage({ data: { error: err }, type: 'error' } satisfies LoadMessageEvents)
    throw err
  }
}

self.addEventListener('message', (event: MessageEvent<WorkerMessageEvent<Load, 'load'> | WorkerMessageEvent<Process, 'process'>>) => {
  const { type } = event.data

  switch (type) {
    case 'process':
      process(event.data.data.imageBuffer, event.data.data.imageWidth, event.data.data.imageHeight, event.data.data.channels)
      break
    case 'load':
      load('Xenova/yolos-tiny')
      break
  }
})
