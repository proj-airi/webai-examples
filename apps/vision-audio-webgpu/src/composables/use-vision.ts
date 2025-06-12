import type { LoadOptionProgressCallback, ProgressInfo, ProgressStatusInfo } from '@xsai-transformers/shared/types'
import type { VLMWorker } from '../workers/vision/vlm'

import { useDevicesList, useElementBounding, useUserMedia } from '@vueuse/core'
import { check } from 'gpuu/webgpu'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import { createVLMWorker } from '../workers/vision/vlm'
import workerURL from '../workers/vision/worker?worker&url'

export const useVisionStore = defineStore('vision', () => {
  // Vision state
  const { videoInputs, permissionGranted, isSupported } = useDevicesList({
    constraints: { video: true, audio: false },
    requestPermissions: true,
  })

  const videoScreenContainer = ref<HTMLDivElement>()
  const videoScreen = ref<HTMLVideoElement>()
  const captureCanvas = ref<HTMLCanvasElement>()

  const selectedVideoSourceDeviceId = ref<ConstrainDOMString>()
  const videoSourceDeviceId = computed<ConstrainDOMString | undefined>({
    get: () => {
      if (!selectedVideoSourceDeviceId.value) {
        return videoInputs.value[0]?.deviceId
      }
      return selectedVideoSourceDeviceId.value
    },
    set: (val) => {
      selectedVideoSourceDeviceId.value = val
      return selectedVideoSourceDeviceId.value
    },
  })

  const videoConstraints = computed(() => ({ video: { deviceId: selectedVideoSourceDeviceId.value } }))
  const { stream: videoStream, start: startVideo } = useUserMedia({
    constraints: videoConstraints,
    enabled: true,
    autoSwitch: true,
  })

  const isWebGPUSupported = ref(true)
  const visionLoaded = ref(false)
  const isModelLoading = ref(false)
  const isWebGPULoading = ref(false)

  const instructionText = ref('What do you see in this image?')
  const responseText = ref('')

  // Vision performance controls
  const scale = ref(0.3)
  const maxImageSize = ref(224)

  // Performance monitoring
  const fpsCounter = ref(0)
  const lastFrameTime = ref(0)
  const processingTime = ref(0)

  const loadingItems = ref<ProgressInfo[]>([])
  const loadingItemsSet = new Set<string>()
  const overallProgress = ref(0)
  const overallTotal = ref(0)

  const vlmWorker = ref<VLMWorker>()

  const videoScreenContainerBounding = useElementBounding(videoScreenContainer, { immediate: true, windowResize: true })

  // Capture image from video stream
  function captureImage() {
    if (!videoStream || !videoScreen.value?.videoWidth || !captureCanvas.value) {
      console.warn('Video stream not ready for capture.')
      return null
    }

    const videoElement = videoScreen.value
    const originalWidth = videoElement.videoWidth
    const originalHeight = videoElement.videoHeight

    const scaledWidth = Math.round(originalWidth * scale.value)
    const scaledHeight = Math.round(originalHeight * scale.value)

    const aspectRatio = originalWidth / originalHeight
    let finalWidth = scaledWidth
    let finalHeight = scaledHeight

    if (Math.max(scaledWidth, scaledHeight) > maxImageSize.value) {
      if (scaledWidth > scaledHeight) {
        finalWidth = maxImageSize.value
        finalHeight = Math.round(maxImageSize.value / aspectRatio)
      }
      else {
        finalHeight = maxImageSize.value
        finalWidth = Math.round(maxImageSize.value * aspectRatio)
      }
    }

    captureCanvas.value.width = finalWidth
    captureCanvas.value.height = finalHeight

    const context = captureCanvas.value.getContext('2d', { willReadFrequently: true })
    if (!context) {
      console.warn('Canvas context not ready for capture.')
      return null
    }

    context.drawImage(videoElement, 0, 0, finalWidth, finalHeight)
    const frame = context.getImageData(0, 0, finalWidth, finalHeight)

    return {
      imageBuffer: frame.data,
      imageWidth: frame.width,
      imageHeight: frame.height,
      channels: 4 as 1 | 2 | 3 | 4,
    }
  }

  // Process image with vision model
  async function processImage(instruction?: string) {
    const capturedImage = captureImage()
    if (!capturedImage)
      return null

    try {
      const startTime = performance.now()
      const response = await vlmWorker.value?.process({
        instruction: instruction || instructionText.value,
        imageBuffer: capturedImage.imageBuffer,
        imageWidth: capturedImage.imageWidth,
        imageHeight: capturedImage.imageHeight,
        channels: capturedImage.channels,
      })
      const endTime = performance.now()

      processingTime.value = Math.round(endTime - startTime)
      if (lastFrameTime.value) {
        const frameTime = endTime - lastFrameTime.value
        fpsCounter.value = Math.round(1000 / frameTime * 100) / 100
      }
      lastFrameTime.value = endTime

      responseText.value = response ?? ''
      return response
    }
    catch (e) {
      console.error(e)
      const errorMessage = `Error: ${e instanceof Error ? e.message : 'Unknown error'}`
      responseText.value = errorMessage
      return null
    }
  }

  // Check WebGPU support
  function checkWebGPU() {
    check().then((result) => {
      isWebGPUSupported.value = result.supported
    })
  }

  // Progress callback for model loading
  const onProgress: LoadOptionProgressCallback = async (progress) => {
    if (progress.status === 'initiate') {
      if (loadingItemsSet.has(progress.file)) {
        return
      }
      loadingItemsSet.add(progress.file)
      loadingItems.value.push(progress)
      isModelLoading.value = true
    }
    else if (progress.status === 'progress') {
      const itemIndex = loadingItems.value.findIndex((item: unknown) => {
        return (item as ProgressStatusInfo).file === progress.file
      })

      if (itemIndex >= 0) {
        loadingItems.value[itemIndex] = progress
        let newTotalSize = 0
        let newLoadedSize = 0

        for (const item of loadingItems.value) {
          if ('total' in item && item.total) {
            newTotalSize += item.total
            if ('loaded' in item && item.loaded) {
              newLoadedSize += item.loaded
            }
          }
        }

        overallTotal.value = newTotalSize
        if (newTotalSize > 0) {
          overallProgress.value = (newLoadedSize / newTotalSize) * 100
        }
      }
    }
    else if (progress.status === 'done') {
      const itemIndex = loadingItems.value.findIndex((item: unknown) => {
        return (item as ProgressStatusInfo).file === progress.file
      })

      if (itemIndex >= 0) {
        loadingItems.value[itemIndex] = progress
      }

      const allDone = loadingItems.value.every(item =>
        item.status === 'done' || item.status === 'ready',
      )

      if (allDone) {
        isModelLoading.value = false
        overallProgress.value = 100
      }
    }
    else if (progress.status === 'ready') {
      isModelLoading.value = false
      overallProgress.value = 100
    }
  }

  // Load vision model
  async function loadVisionModel() {
    if (!visionLoaded.value) {
      isWebGPULoading.value = true
      await vlmWorker.value?.load({ onProgress })
      isWebGPULoading.value = false
      visionLoaded.value = true
    }
  }

  // Initialize vision worker
  function initializeVisionWorker() {
    vlmWorker.value = createVLMWorker({ baseURL: workerURL })
  }

  // Cleanup
  function cleanup() {
    vlmWorker.value?.dispose()
  }

  // Watch for video stream changes
  watch([videoStream, videoScreen], () => {
    if (videoStream.value && videoScreen.value) {
      videoScreen.value.srcObject = videoStream.value
    }
  })

  // Watch for video source changes
  watch(selectedVideoSourceDeviceId, () => selectedVideoSourceDeviceId.value && startVideo())

  return {
    // Refs
    videoScreenContainer,
    videoScreen,
    captureCanvas,

    // State
    videoInputs,
    permissionGranted,
    isSupported,
    videoSourceDeviceId,
    videoStream,
    isWebGPUSupported,
    visionLoaded,
    isModelLoading,
    isWebGPULoading,
    instructionText,
    responseText,
    scale,
    maxImageSize,
    fpsCounter,
    processingTime,
    loadingItems,
    overallProgress,
    overallTotal,
    videoScreenContainerBounding,

    // Methods
    captureImage,
    processImage,
    checkWebGPU,
    loadVisionModel,
    initializeVisionWorker,
    cleanup,
    onProgress,
  }
})
