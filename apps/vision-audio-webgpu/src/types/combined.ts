import type { Ref } from 'vue'

// Interface for captured image
export interface CapturedImage {
  imageBuffer: Uint8ClampedArray
  imageWidth: number
  imageHeight: number
  channels: 1 | 2 | 3 | 4
}

// Type for combined mode state and functions
export interface CombinedMode {
  // State
  combinedMode: Ref<boolean>
  callStarted: Ref<boolean>
  elapsedTime: Ref<string>
  ripples: Ref<number[]>
  lastCapturedImage: Ref<CapturedImage | null>

  // Methods
  startCombinedSession: () => Promise<void>
  stopCombinedSession: () => void
}
