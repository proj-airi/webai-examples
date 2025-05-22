import type { ObjectDetectionPipelineSingle } from '@huggingface/transformers'
import type { LoadOptions } from '@xsai-transformers/shared/types'

export interface Load<T = object> {
  options?: LoadOptions<T>
}

export interface Process {
  imageBuffer: Uint8ClampedArray | Uint8Array
  imageWidth: number
  imageHeight: number
  channels: 1 | 2 | 3 | 4
}

export interface ProcessResult {
  input: {
    imageBuffer: Uint8ClampedArray | Uint8Array
    imageWidth: number
    imageHeight: number
    channels: 1 | 2 | 3 | 4
  }
  output: {
    data: ObjectDetectionPipelineSingle[]
  }
}
