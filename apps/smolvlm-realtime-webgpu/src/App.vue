<script setup lang="ts">
import type { LoadOptionProgressCallback, ProgressInfo, ProgressStatusInfo } from '@xsai-transformers/shared/types'

import { useDark, useDevicesList, useElementBounding, useUserMedia } from '@vueuse/core'
import { check } from 'gpuu/webgpu'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import type { VLMWorker } from './libs/vlm'

import Progress from './components/Progress.vue'
import Range from './components/Range.vue'
import { createVLMWorker } from './libs/vlm'
import workerURL from './libs/worker?worker&url'

const { videoInputs, permissionGranted, isSupported } = useDevicesList({ constraints: { video: true, audio: false }, requestPermissions: true })

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
const constraints = computed(() => ({ video: { deviceId: selectedVideoSourceDeviceId.value } }))

const isWebGPUSupported = ref(true)

const loaded = ref(false)
const isProcessing = ref(false)
const isModelLoading = ref(false)
const isWebGPULoading = ref(false)

const instructionText = ref('In one sentence, what do you see?')
const responseText = ref('')

// Performance controls
const scale = ref(0.3) // Camera stream scale factor (smaller = faster)
const maxImageSize = ref(224) // Maximum image dimension for processing
const processingInterval = ref(2000) // Minimum time between processing (ms)

// Performance monitoring
const fpsCounter = ref(0)
const lastFrameTime = ref(0)
const processingTime = ref(0)

const loadingItems = ref<ProgressInfo[]>([])
const loadingItemsSet = new Set<string>()
const overallProgress = ref(0)
const overallTotal = ref(0)

const vlmWorker = ref<VLMWorker>()

const isDark = useDark({ disableTransition: false })
const videoScreenContainerBounding = useElementBounding(videoScreenContainer, { immediate: true, windowResize: true })
const { stream, start } = useUserMedia({ constraints, enabled: true, autoSwitch: true })

function captureImage() {
  if (!stream || !videoScreen.value?.videoWidth || !captureCanvas.value) {
    console.warn('Video stream not ready for capture.')
    return null
  }

  // Apply scale to reduce processing load
  const videoElement = videoScreen.value
  const originalWidth = videoElement.videoWidth
  const originalHeight = videoElement.videoHeight

  // Calculate scaled dimensions
  const scaledWidth = Math.round(originalWidth * scale.value)
  const scaledHeight = Math.round(originalHeight * scale.value)

  // Further limit by maxImageSize to control model input
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

function checkWebGPU() {
  check().then((result) => {
    isWebGPUSupported.value = result.supported
  })
}

async function sendData() {
  if (!isProcessing.value)
    return

  const instruction = instructionText.value
  const rawImg = captureImage()
  if (!rawImg) {
    responseText.value = 'Capture failed'
    return
  }

  try {
    const startTime = performance.now()
    const response = await vlmWorker.value?.process({
      instruction,
      imageBuffer: rawImg.imageBuffer,
      imageWidth: rawImg.imageWidth,
      imageHeight: rawImg.imageHeight,
      channels: rawImg.channels,
    })
    const endTime = performance.now()

    // Calculate processing time and FPS
    processingTime.value = Math.round(endTime - startTime)
    if (lastFrameTime.value) {
      const frameTime = endTime - lastFrameTime.value
      fpsCounter.value = Math.round(1000 / frameTime * 100) / 100 // 2 decimal places
    }
    lastFrameTime.value = endTime

    responseText.value = response ?? ''
  }
  catch (e) {
    console.error(e)
    responseText.value = `Error: ${e instanceof Error ? e.message : 'Unknown error'}`
  }
}

let animationFrameId: number | null = null
let lastProcessTime = 0

function processingLoop() {
  if (!isProcessing.value) {
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
    return
  }

  const now = performance.now()

  // Only process if enough time has passed (respecting processingInterval)
  if (now - lastProcessTime >= processingInterval.value) {
    lastProcessTime = now
    sendData().finally(() => {
      if (isProcessing.value) {
        animationFrameId = requestAnimationFrame(processingLoop)
      }
    })
  }
  else {
    // Schedule next check
    if (isProcessing.value) {
      animationFrameId = requestAnimationFrame(processingLoop)
    }
  }
}

const onProgress: LoadOptionProgressCallback = async (progress) => {
  if (progress.status === 'initiate') {
    // New file discovered
    if (loadingItemsSet.has(progress.file)) {
      return
    }

    loadingItemsSet.add(progress.file)
    loadingItems.value.push(progress)
    isModelLoading.value = true
  }
  else if (progress.status === 'progress') {
    // Update progress for an existing file
    const itemIndex = loadingItems.value.findIndex((item: unknown) => {
      return (item as ProgressStatusInfo).file === progress.file
    })

    if (itemIndex >= 0) {
      // Update the item in the array
      loadingItems.value[itemIndex] = progress

      // Now recalculate the overall progress

      // First, calculate the total expected size of all known files
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

      // Update the total size tracker
      overallTotal.value = newTotalSize

      // Calculate overall progress as a percentage
      if (newTotalSize > 0) {
        overallProgress.value = (newLoadedSize / newTotalSize) * 100
      }
    }
    else {
      // This is a progress update for a file we haven't seen before
      loadingItems.value.push(progress)

      // Recalculate total (same as above)
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
      // Set progress to 100% when done
      overallProgress.value = 100
    }
  }
  else if (progress.status === 'ready') {
    isModelLoading.value = false
    // Set progress to 100% when ready
    overallProgress.value = 100
  }
}

async function handleStart() {
  if (!stream) {
    responseText.value = 'Camera not available. Cannot start.'
    console.warn('Camera not available. Please grant permission first.')
    return
  }

  if (!loaded.value) {
    isWebGPULoading.value = true
    await vlmWorker.value?.load({ onProgress })
    isWebGPULoading.value = false
    loaded.value = true
  }

  isProcessing.value = true
  responseText.value = '...'
  processingLoop()
}

function handleStop() {
  isProcessing.value = false
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = null
  }
  if (responseText.value === '...') {
    responseText.value = ''
  }
}

function handleClick() {
  if (isProcessing.value) {
    handleStop()
  }
  else {
    handleStart()
  }
}

watch([stream, videoScreen], () => {
  if (stream.value && videoScreen.value) {
    videoScreen.value.srcObject = stream.value
  }
})
watch(selectedVideoSourceDeviceId, () => selectedVideoSourceDeviceId.value && start())

onMounted(() => vlmWorker.value = createVLMWorker({ baseURL: workerURL }))
onMounted(videoScreenContainerBounding.update)
onMounted(checkWebGPU)
onUnmounted(() => vlmWorker.value?.dispose())
</script>

<template>
  <div ref="videoScreenContainer" max-h="100dvh" max-w="100dvw" relative h-full w-full class="p-0 sm:p-4">
    <div relative z-0 h-full w-full overflow-hidden class="rounded-none sm:rounded-3xl" shadow-md>
      <div absolute left-0 top-0 z-10 class="p-2 sm:p-4" flex gap-2>
        <div
          bg="white dark:neutral-900"
          text="black dark:white <sm:xs"
          border="neutral-400/40 dark:neutral-500/50 1 solid"
          class="rounded-xl p-2 sm:rounded-2xl sm:px-3 sm:py-2"
          transition="all duration-300 ease-in-out"
        >
          <div>
            SmolVLM Realtime WebGPU (Vue)
          </div>
        </div>
        <a
          href="https://github.com/proj-airi/webai-examples/tree/main/apps/smolvlm-realtime-webgpu"
          bg="white dark:neutral-900 hover:neutral-100 dark:hover:neutral-800"
          border="neutral-400/40 dark:neutral-500/50 1 solid"
          class="rounded-xl p-2 text-black sm:rounded-2xl sm:px-3 sm:py-2 dark:text-white"
          transition="all duration-300 ease-in-out"
          flex items-center justify-center
        >
          <div i-simple-icons:github class="size-4" />
        </a>
      </div>

      <!-- Performance Monitor -->
      <div
        absolute left-4 top-16 z-10
        bg="white/80 dark:neutral-900/80"
        text="black dark:white <sm:xs"
        border="neutral-400/40 dark:neutral-500/50 1 solid"
        class="rounded-xl p-2 sm:rounded-2xl sm:px-3 sm:py-2"
        transition="all duration-300 ease-in-out"
        flex gap-2
      >
        <span>FPS: <span font-mono>{{ fpsCounter }}</span></span>
        <span>Time: <span font-mono>{{ processingTime }} ms</span></span>
      </div>

      <!-- Control Panel -->
      <div
        bg="neutral-500/40 dark:neutral-900/70"
        text="white/98 dark:neutral-100/90 <sm:xs"
        border="neutral-400/40 dark:neutral-500/50 1 solid"
        class="rounded-xl p-2 sm:rounded-2xl sm:px-3 sm:pb-1 sm:pt-2"
        transition="all duration-300 ease-in-out"
        min-w="280px"
        grid-cols="[0.2fr_0.4fr_1fr]" absolute bottom-16 right-4 z-10 grid items-center gap-x-2 gap-y-1 text-sm
        backdrop-blur-lg
      >
        <!-- Image Scale Control -->
        <div>Scale:</div>
        <label for="scale" w="90px" flex items-center gap-2>
          <Range
            v-model="scale"
            :min="0.1"
            :max="1.0"
            :step="0.1"
            :disabled="isProcessing"
            class="flex-1"
          />
        </label>
        <div text-right font-mono>
          {{ scale.toFixed(1) }}
        </div>

        <!-- Max Image Size Control -->
        <div>Max Size:</div>
        <label for="max-size" w="90px" flex items-center gap-2>
          <Range
            v-model="maxImageSize"
            :min="128"
            :max="512"
            :step="32"
            :disabled="isProcessing"
            class="flex-1"
          />
        </label>
        <div text-right font-mono>
          {{ maxImageSize }}
        </div>

        <!-- Processing Interval Control -->
        <div>Interval:</div>
        <label for="interval" w="90px" flex items-center gap-2>
          <Range
            v-model="processingInterval"
            :min="500"
            :max="5000"
            :step="250"
            class="flex-1"
          />
        </label>
        <div text-right font-mono>
          {{ (processingInterval / 1000).toFixed(1) }}s
        </div>

        <!-- Instruction Input -->
        <div min-w-20>
          Ask:
        </div>
        <label for="instruction" col-span-2 w-full flex items-center gap-2>
          <input
            v-model="instructionText"
            placeholder="What do you see?"
            type="text"
            :disabled="isProcessing"
            border="focus:neutral-400 dark:focus:neutral-500 2 focus:2 solid neutral-500/50 dark:neutral-900"
            transition="all duration-200 ease-in-out"
            cursor="disabled:not-allowed"
            shadow="sm"
            w-full flex-1 rounded-lg px-2 py-1 text-nowrap text-sm outline-none
            bg="neutral-700/50 dark:neutral-950 focus:neutral-700/50 dark:focus:neutral-900"
            text="disabled:neutral-400 dark:disabled:neutral-600"
          >
        </label>
        <div />
      </div>

      <button
        text="white/98 dark:neutral-100/90 <sm:xs"
        border="neutral-400/40 dark:neutral-500/50 1 solid"
        transition="all duration-300 ease-in-out"
        class="bottom-2 left-2 max-h-8 px-2 sm:bottom-4 sm:left-4 sm:max-h-10 sm:px-3 sm:py-2"
        absolute z-10 h-full flex items-center rounded-full backdrop-blur-lg
        :class="[
          isProcessing ? 'bg-red-700/60 dark:bg-red-900/90 hover:bg-red-800/60 dark:hover:bg-red-900/90' : 'bg-green-700/60 dark:bg-green-900/90 hover:bg-green-800/60 dark:hover:bg-green-900/90',
        ]"
        @click="handleClick"
      >
        <template v-if="isProcessing">
          Stop
        </template>
        <template v-else-if="isWebGPULoading || isModelLoading">
          <div i-svg-spinners:6-dots-rotate size-4 />
        </template>
        <template v-else>
          Start
        </template>
      </button>
      <div
        v-if="loadingItems.length > 0 && isModelLoading"
        bottom="20" left="1/2" translate-x="-50%" max-w="50"
        absolute z-10 h-5 w-full
      >
        <Progress :percentage="Math.min(100, overallProgress)" />
      </div>
      <div
        v-if="responseText"
        translate-x="-50%" absolute bottom="20" left="1/2" z-10
        bg="neutral-700/60 dark:neutral-900/90"
        text="white/98 dark:neutral-100/90 xs sm:xl"
        border="neutral-400/40 dark:neutral-500/50 1 solid"
        transition="all duration-300 ease-in-out"
        class="rounded-xl px-2 py-1 sm:rounded-2xl sm:px-3 sm:py-2"
        backdrop-blur-lg
        max-w="80%"
      >
        {{ responseText }}
      </div>

      <!-- Capabilities check -->
      <div v-if="!isSupported" absolute left-0 top-0 z-1 h-full w-full flex flex-col items-center justify-center gap-3 bg="neutral-50/20">
        <div text="neutral-700 dark:neutral-300 4xl" font-semibold>
          Not Supported
        </div>
        <div max-w="50%" text="neutral 2xl center">
          {{ 'Browser does not support video camera. Please use a supported browser.' }}
        </div>
      </div>
      <div v-else-if="!isWebGPUSupported" absolute left-0 top-0 z-1 h-full w-full flex flex-col items-center justify-center gap-3 bg="neutral-50/20">
        <div text="neutral-700 dark:neutral-300 4xl" font-semibold>
          Not Supported
        </div>
        <div max-w="50%" text="neutral 2xl center">
          {{ 'Browser does not support WebGPU. Please use a supported browser.' }}
        </div>
      </div>
      <!-- Permission check -->
      <div v-else-if="!permissionGranted" absolute left-0 top-0 z-1 h-full w-full flex flex-col items-center justify-center gap-3 bg="orange-50/20 dark:orange-900/10">
        <div text="orange-700 4xl" font-semibold>
          Warning
        </div>
        <div max-w="50%" text="orange 2xl center">
          {{ 'Permission not granted. Please grant permission first. Then choose a camera from the dropdown menu.' }}
        </div>
      </div>

      <template v-else>
        <video ref="videoScreen" autoplay muted relative z-0 h-full w-full object-cover />
        <canvas ref="captureCanvas" class="hidden" />
      </template>

      <div gap="1 sm:2" absolute bottom-0 right-0 z-10 h-full flex items-center class="max-h-12 p-2 sm:max-h-18 sm:p-4">
        <select
          v-model="videoSourceDeviceId"
          bg="neutral-500/40 hover:neutral-600/40 dark:neutral-900/70 hover:dark:neutral-900/60"
          text="white/98 dark:neutral-100/90 <sm:xs"
          border="neutral-400/40 dark:neutral-500/50 1 solid"
          outline="none"
          shadow="none hover:lg"
          transition="all duration-300 ease-in-out"
          h-full cursor-pointer rounded-full class="px-2 sm:px-3" backdrop-blur-lg
        >
          <option
            v-for="device in videoInputs"
            :key="device.deviceId"
            :value="device.deviceId"
            class="text-xs sm:text-sm"
            inline-block
          >
            {{ device.label }}
          </option>
        </select>
        <button
          bg="neutral-500/40 hover:neutral-600/40 dark:neutral-900/70 hover:dark:neutral-900/60"
          text="white/98 dark:neutral-100/90"
          border="neutral-400/40 dark:neutral-500/50 1 solid"
          outline="none"
          shadow="none hover:lg"
          transition="all duration-300 ease-in-out"
          aspect-square h-full flex cursor-pointer items-center justify-center rounded-full backdrop-blur-lg
          @click="isDark = !isDark"
        >
          <Transition name="fade" mode="out-in">
            <div v-if="isDark" i-solar:moon-stars-bold class="size-4" />
            <div v-else i-solar:sun-bold class="size-4" />
          </Transition>
        </button>
      </div>
    </div>
  </div>
</template>

<style>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease-in-out;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0.5;
}

.fade-enter-to,
.fade-leave-from {
  opacity: 1;
}
</style>
