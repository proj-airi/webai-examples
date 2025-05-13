/* eslint-disable no-restricted-globals */
import type { PreTrainedModel, Processor, ProgressInfo, Tensor } from '@huggingface/transformers'
import type { WorkerMessageEvent } from './types'

import { AutoModelForVision2Seq, AutoProcessor, RawImage } from '@huggingface/transformers'
import { check } from 'gpuu/webgpu'

import { MessageStatus } from './types'

async function isWebGPUSupported(): Promise<boolean> {
  const result = await check()
  return result.supported
}

let processor: Processor
let model: PreTrainedModel

async function process(instruction: string, imageBuffer: Uint8ClampedArray | Uint8Array, imageWidth: number, imageHeight: number, channels: 1 | 2 | 3 | 4) {
  const messages = [{
    role: 'user',
    content: [
      { type: 'image' },
      { type: 'text', text: instruction },
    ],
  }]

  const img = new RawImage(imageBuffer, imageWidth, imageHeight, channels)

  // @ts-expect-error - messages is not typed
  const text = processor.apply_chat_template(messages, { add_generation_prompt: true })
  const inputs = await processor(text, [img], { do_image_splitting: false })
  const generatedIds = await model.generate({ ...inputs, max_new_tokens: 100 }) as Tensor | undefined
  const output = processor.batch_decode(
    generatedIds?.slice(null, [inputs.input_ids.dims.at(-1), null]) as Tensor | number[][],
    { skip_special_tokens: true },
  )

  self.postMessage({
    data: {
      input: {
        instruction,
        imageBuffer,
        imageWidth,
        imageHeight,
        channels,
      },
      output: { data: output?.[0]?.trim() || '' },
    },
    type: 'processResult',
  } satisfies WorkerMessageEvent)
}

async function load(modelId: string) {
  try {
    const device = (await isWebGPUSupported()) ? 'webgpu' : 'wasm'

    self.postMessage({ data: { message: `Using device: "${device}"` }, type: 'info' } satisfies WorkerMessageEvent)
    self.postMessage({ data: { message: 'Loading models...' }, type: 'info' } satisfies WorkerMessageEvent)

    processor = await AutoProcessor.from_pretrained(modelId, {
      progress_callback: (progress: ProgressInfo) => {
        self.postMessage({ data: { progress }, type: 'progress' } satisfies WorkerMessageEvent)
      },
    })

    model = await AutoModelForVision2Seq.from_pretrained(modelId, {
      dtype: {
        embed_tokens: 'fp16',
        vision_decoder: 'q4',
        decoder_model_merged: 'q4',
      },
      device,
      progress_callback: (progress) => {
        self.postMessage({ data: { progress }, type: 'progress' } satisfies WorkerMessageEvent)
      },
    })

    self.postMessage({ data: { message: 'Ready!', status: MessageStatus.Ready }, type: 'status' } satisfies WorkerMessageEvent)
  }
  catch (err) {
    self.postMessage({ data: { error: err }, type: 'error' } satisfies WorkerMessageEvent)
    throw err
  }
}

self.addEventListener('message', (event: MessageEvent<WorkerMessageEvent>) => {
  const { type } = event.data

  switch (type) {
    case 'process':
      process(event.data.data.instruction, event.data.data.imageBuffer, event.data.data.imageWidth, event.data.data.imageHeight, event.data.data.channels)
      break
    case 'load':
      load('HuggingFaceTB/SmolVLM-Instruct')
      break
  }
})
