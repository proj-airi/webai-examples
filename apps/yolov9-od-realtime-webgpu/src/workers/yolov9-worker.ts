/* eslint-disable no-restricted-globals */
import type { PreTrainedModel, Processor } from '@huggingface/transformers'
import type { ProgressInfo } from '@xsai-transformers/shared/types'
import type { LoadMessageEvents, ProcessMessageEvents, WorkerMessageEvent } from '@xsai-transformers/shared/worker'
import type { Load, Process } from './types'

import { AutoModel, AutoProcessor, RawImage } from '@huggingface/transformers'
import { isWebGPUSupported } from 'gpuu/webgpu'

let processor: Processor | undefined
let model: PreTrainedModel | undefined
let labelMap: Record<string, string> = {}

export enum MessageStatus {
  Loading = 'loading',
  Ready = 'ready',
}

async function process(imageBuffer: Uint8ClampedArray | Uint8Array, imageWidth: number, imageHeight: number, channels: 1 | 2 | 3 | 4, modelSize?: number, threshold?: number) {
  const startTime = performance.now()
  const img = new RawImage(imageBuffer, imageWidth, imageHeight, channels)

  // Configure processor size if available
  if (processor && modelSize) {
    // Use any type to overcome TypeScript type limitations with dynamic properties
    const featureExtractor = processor.feature_extractor as any
    if (featureExtractor && typeof featureExtractor.size !== 'undefined') {
      featureExtractor.size = { shortest_edge: modelSize }
      console.warn(`Set model size to ${modelSize}px`)
    }
  }

  // Use default threshold if not provided
  const inferenceThreshold = threshold || 0.25

  try {
    // Process the image and run the model
    const inputs = await processor!(img)
    const { outputs } = await model!(inputs, { threshold: inferenceThreshold })
    console.warn(`Model inference time: ${performance.now() - startTime}ms with threshold ${inferenceThreshold}`)

    // Convert tensor outputs to plain JavaScript array
    const outputArray = await convertRawOutputsToDetections(outputs)

    self.postMessage({
      data: { data: outputArray },
      type: 'processResult',
    } satisfies ProcessMessageEvents)
  }
  catch (error) {
    console.error('Error processing image:', error)
    self.postMessage({
      data: { error },
      type: 'error',
    } satisfies LoadMessageEvents)
  }
}

// Helper function to convert raw tensor outputs to structured detection objects
async function convertRawOutputsToDetections(outputs: any) {
  try {
    // If it's a tensor with tolist method, convert to array first
    let rawDetections = outputs
    if (outputs && typeof outputs.tolist === 'function') {
      rawDetections = await outputs.tolist()
    }

    console.warn('Raw detections format:', rawDetections && Array.isArray(rawDetections)
      ? `Array of ${rawDetections.length} items`
      : typeof rawDetections)

    // Log the first few raw detections to understand the format
    if (Array.isArray(rawDetections) && rawDetections.length > 0) {
      console.warn('First raw detection:', rawDetections[0])
      if (rawDetections.length > 1) {
        console.warn('Second raw detection:', rawDetections[1])
      }
    }

    // Check if we have an array of arrays format
    if (Array.isArray(rawDetections)) {
      return rawDetections.map((detection, index) => {
        // Check if this is an array with 6 elements
        if (Array.isArray(detection) && detection.length >= 6) {
          const [val1, val2, val3, val4, score, classId] = detection

          console.warn(`Detection ${index}: [${val1}, ${val2}, ${val3}, ${val4}, ${score}, ${classId}]`)

          // Try different interpretations of the coordinate format
          let box

          // Check if this might be [x_center, y_center, width, height] format (common in YOLO)
          if (val3 > 0 && val4 > 0 && val1 > val3 / 2 && val2 > val4 / 2) {
            // This looks like center + width/height format
            const x_center = val1
            const y_center = val2
            const width = val3
            const height = val4

            box = {
              xmin: x_center - width / 2,
              ymin: y_center - height / 2,
              xmax: x_center + width / 2,
              ymax: y_center + height / 2,
            }
            console.warn(`Interpreted as center format: center(${x_center}, ${y_center}) size(${width}, ${height}) → box`, box)
          }
          else {
            // Assume [xmin, ymin, xmax, ymax] but check for flipped coordinates
            let xmin = val1
            let ymin = val2
            let xmax = val3
            let ymax = val4

            // Fix flipped coordinates
            if (xmin > xmax) {
              [xmin, xmax] = [xmax, xmin]
              console.warn(`Fixed flipped X coordinates: ${val1} > ${val3}`)
            }
            if (ymin > ymax) {
              [ymin, ymax] = [ymax, ymin]
              console.warn(`Fixed flipped Y coordinates: ${val2} > ${val4}`)
            }

            box = { xmin, ymin, xmax, ymax }
            console.warn(`Interpreted as bbox format:`, box)
          }

          return {
            box,
            score: Number(score),
            label: getLabel(classId.toString()),
          }
        }
        // If already in {box, label, score} format, return as is
        else if (detection && typeof detection === 'object' && 'box' in detection) {
          return {
            box: {
              xmin: Number(detection.box.xmin),
              ymin: Number(detection.box.ymin),
              xmax: Number(detection.box.xmax),
              ymax: Number(detection.box.ymax),
            },
            score: Number(detection.score),
            label: detection.label,
          }
        }

        // Unknown format, return empty object
        console.warn('Unknown detection format:', detection)
        return {
          box: { xmin: 0, ymin: 0, xmax: 0, ymax: 0 },
          score: 0,
          label: 'unknown',
        }
      })
    }

    // Unknown format, return empty array
    console.warn('Unknown output format, could not convert to detections')
    return []
  }
  catch (error) {
    console.error('Error converting outputs:', error)
    return []
  }
}

// Helper function to get class label from ID
function getLabel(classId: string): string {
  // If we have a label map, use it
  if (labelMap[classId]) {
    return labelMap[classId]
  }

  // If model has config with id2label, use it
  if (model && (model as any).config && (model as any).config.id2label) {
    const label = (model as any).config.id2label[classId]
    if (label) {
      labelMap[classId] = label
      return label
    }
  }

  // Otherwise, return the class ID
  return `Class ${classId}`
}

async function load(modelId: string) {
  try {
    const device = (await isWebGPUSupported()) ? 'webgpu' : 'wasm'

    self.postMessage({ data: { message: `Using device: "${device}"` }, type: 'info' } satisfies LoadMessageEvents)
    self.postMessage({ data: { message: 'Loading models...' }, type: 'info' } satisfies LoadMessageEvents)

    // eslint-disable-next-line ts/ban-ts-comment
    // @ts-ignore - Expression produces a union type that is too complex to represent.ts(2590)
    model = await AutoModel.from_pretrained(modelId, {
      device,
      progress_callback: (progress: ProgressInfo) => {
        self.postMessage({ data: { progress }, type: 'progress' } satisfies LoadMessageEvents)
      },
    })
    processor = await AutoProcessor.from_pretrained(modelId, {
      device,
      progress_callback: (progress: ProgressInfo) => {
        self.postMessage({ data: { progress }, type: 'progress' } satisfies LoadMessageEvents)
      },
    })

    // Check if model has label mapping (id2label)
    if (model && (model as any).config && (model as any).config.id2label) {
      labelMap = (model as any).config.id2label
      console.warn(`Loaded label map with ${Object.keys(labelMap).length} classes`)
    }

    // Set initial model size if processor supports it
    if (processor && processor.feature_extractor) {
      console.warn('Processor loaded, feature extractor available')
    }

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
      process(
        event.data.data.imageBuffer,
        event.data.data.imageWidth,
        event.data.data.imageHeight,
        event.data.data.channels,
        event.data.data.modelSize,
        event.data.data.threshold,
      )
      break
    case 'load':
      // Use a smaller model here - this typically runs much faster
      load('Xenova/gelan-c_all')
      // Alternative options:
      // load('Xenova/yolos-tiny')
      break
  }
})
