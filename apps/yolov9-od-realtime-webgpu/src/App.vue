<script setup lang="ts">
import type { ObjectDetectionPipelineSingle } from '@huggingface/transformers'

import { useDark, useDevicesList, useElementBounding, useUserMedia } from '@vueuse/core'
import { check } from 'gpuu/webgpu'
import { computed, onMounted, ref, watch } from 'vue'

import Progress from './components/Progress.vue'
import Range from './components/Range.vue'
import { useTransformersWorker } from './composables/use-transformers-worker'
import workerURL from './workers/yolov9-worker?worker&url'

const { videoInputs, permissionGranted, isSupported } = useDevicesList({ constraints: { video: true, audio: false }, requestPermissions: true })

const videoScreenContainer = ref<HTMLDivElement>()
const videoScreen = ref<HTMLVideoElement>()
const captureCanvas = ref<HTMLCanvasElement>()

// Store original dimensions
const originalWidth = ref(0)
const originalHeight = ref(0)

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

const borderColorSets = [
  'border-sky-500',
  'border-blue-500',
  'border-indigo-500',
  'border-violet-500',
  'border-purple-500',
  'border-fuchsia-500',
  'border-pink-500',
  'border-rose-500',
  'border-red-500',
  'border-orange-500',
  'border-amber-500',
  'border-yellow-500',
  'border-lime-500',
  'border-green-500',
  'border-teal-500',
  'border-cyan-500',
]

const bgColorSets = [
  'bg-sky-500',
  'bg-blue-500',
  'bg-indigo-500',
  'bg-violet-500',
  'bg-purple-500',
  'bg-fuchsia-500',
  'bg-pink-500',
  'bg-rose-500',
  'bg-red-500',
  'bg-orange-500',
  'bg-amber-500',
  'bg-yellow-500',
  'bg-lime-500',
  'bg-green-500',
  'bg-teal-500',
  'bg-cyan-500',
]

const constraints = computed(() => ({ video: { deviceId: selectedVideoSourceDeviceId.value } }))

const modelSize = ref(64) // Control model input size
const threshold = ref(0.5) // Detection confidence threshold
const scale = ref(0.5) // Camera stream scale factor

const loaded = ref(false)
const isProcessing = ref(false)
const isWebGPULoading = ref(false)
const isWebGPUSupported = ref(true)
const fpsCounter = ref(0)
const lastFrameTime = ref(0)

const isDark = useDark({ disableTransition: false })
const videoScreenContainerBounding = useElementBounding(videoScreenContainer, { immediate: true, windowResize: true })
const { stream, start } = useUserMedia({ constraints, enabled: true, autoSwitch: true })

const { isLoading, load, loadingItems, process, overallProgress } = useTransformersWorker(workerURL, 'object-detection')

const detectedObjects = ref<ObjectDetectionPipelineSingle[]>([])

function checkWebGPU() {
  check().then((result) => {
    isWebGPUSupported.value = result.supported
  })
}

function applyVideoScale() {
  if (videoScreen.value && captureCanvas.value && stream.value) {
    const videoTrack = stream.value.getVideoTracks()[0]
    if (videoTrack) {
      const { width, height } = videoTrack.getSettings()
      if (width && height) {
        // Store original dimensions for scaling back
        originalWidth.value = width
        originalHeight.value = height

        const newWidth = Math.round(width * scale.value)
        const newHeight = Math.round(height * scale.value)
        captureCanvas.value.width = newWidth
        captureCanvas.value.height = newHeight
      }
    }
  }
}

function captureImage() {
  if (!stream || !videoScreen.value?.videoWidth || !captureCanvas.value) {
    console.warn('Video stream not ready for capture.')
    return null
  }

  applyVideoScale()

  const context = captureCanvas.value.getContext('2d', { willReadFrequently: true })
  if (!context) {
    console.warn('Canvas context not ready for capture.')
    return null
  }

  context.drawImage(videoScreen.value, 0, 0, captureCanvas.value.width, captureCanvas.value.height)
  const frame = context.getImageData(0, 0, captureCanvas.value.width, captureCanvas.value.height)

  return {
    imageBuffer: frame.data,
    imageWidth: frame.width,
    imageHeight: frame.height,
    channels: 4 as 1 | 2 | 3 | 4,
  }
}

async function sendData() {
  if (!isProcessing.value)
    return
  const rawImg = captureImage()
  if (!rawImg) {
    return
  }
  try {
    const response = await process({
      imageBuffer: rawImg.imageBuffer,
      imageWidth: rawImg.imageWidth,
      imageHeight: rawImg.imageHeight,
      channels: rawImg.channels,
      modelSize: modelSize.value,
      threshold: threshold.value,
    })
    const endTime = performance.now()

    // Calculate FPS
    if (lastFrameTime.value) {
      const frameTime = endTime - lastFrameTime.value
      fpsCounter.value = Math.round(1000 / frameTime)
    }
    lastFrameTime.value = endTime

    if (response && response.length > 0) {
      // Scale bounding boxes back to original video dimensions
      const videoElement = videoScreen.value
      if (!videoElement)
        return

      // Get the dimensions we need for scaling
      const displayWidth = videoElement.offsetWidth
      const displayHeight = videoElement.offsetHeight

      // Get processed image dimensions
      const processedWidth = rawImg.imageWidth
      const processedHeight = rawImg.imageHeight

      // For the rendering on screen, we need to consider the actual display dimensions
      detectedObjects.value = response.map((item) => {
        // Get original coordinates
        const { xmin, ymin, xmax, ymax } = item.box
        console.warn('before', item.box)

        // Determine if coordinates seem normalized (between 0-1) or in pixel space
        const isNormalized = xmax <= 1 && ymax <= 1

        let scaledBox
        if (isNormalized) {
          // If coordinates are normalized (0-1), directly multiply by display dimensions
          scaledBox = {
            xmin: xmin * displayWidth,
            ymin: ymin * displayHeight,
            xmax: xmax * displayWidth,
            ymax: ymax * displayHeight,
          }
        }
        else {
          // If coordinates are in pixel space relative to the model input, scale proportionally

          // Calculate the model dimensions (could be different from processed dimensions due to padding)
          // Default to the model size if available
          const modelWidth = modelSize.value || processedWidth
          const modelHeight = modelSize.value || processedHeight

          // How the model's coordinates relate to the actual frame depends on model preprocessing
          // For many models, we need to account for aspect ratio preservation and letterboxing

          // Scale from model space to display space
          const xScale = displayWidth / modelWidth
          const yScale = displayHeight / modelHeight

          scaledBox = {
            xmin: xmin * xScale,
            ymin: ymin * yScale,
            xmax: xmax * xScale,
            ymax: ymax * yScale,
          }
        }

        console.warn('after', scaledBox)

        return {
          box: scaledBox,
          label: item.label,
          score: item.score,
        }
      })
    }
    else {
      detectedObjects.value = []
    }
  }
  catch (e) {
    console.error(e)
  }
}

let animationFrameId: number | null = null

function processingLoop() {
  if (!isProcessing.value) {
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
    return
  }

  sendData().finally(() => {
    if (isProcessing.value) {
      animationFrameId = requestAnimationFrame(processingLoop)
    }
  })
}

async function handleStart() {
  if (!stream) {
    console.warn('Camera not available. Please grant permission first.')
    return
  }

  if (!loaded.value) {
    isWebGPULoading.value = true
    await load()
    isWebGPULoading.value = false
    loaded.value = true
  }

  isProcessing.value = true
  processingLoop()
}

function handleStop() {
  isProcessing.value = false
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = null
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

onMounted(videoScreenContainerBounding.update)
onMounted(checkWebGPU)
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
            YOLOv9 Object Detection Realtime WebGPU (Vue)
          </div>
        </div>
        <a
          href="https://github.com/proj-airi/webai-examples/tree/main/apps/yolov9-od-realtime-webgpu"
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
        <span>Objects: <span font-mono>{{ detectedObjects.length }}</span></span>
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
      >
        <!-- Model Size Control -->
        <div>Size:</div>
        <label for="model-size" w="90px" flex items-center gap-2>
          <Range
            v-model="modelSize"
            :min="32"
            :max="128"
            :step="16"
            :disabled="isProcessing"
            class="flex-1"
          />
        </label>
        <div text-right font-mono>
          {{ modelSize }}
        </div>

        <!-- Threshold Control -->
        <div>Threshold:</div>
        <label for="threshold" w="90px" flex items-center gap-2>
          <Range
            v-model="threshold"
            :min="0.1"
            :max="0.9"
            :step="0.05"
            class="flex-1"
          />
        </label>
        <div text-right font-mono>
          {{ threshold.toFixed(2) }}
        </div>

        <!-- Scale Control -->
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
        <template v-else-if="isWebGPULoading || isLoading">
          <div i-svg-spinners:6-dots-rotate size-4 />
        </template>
        <template v-else>
          Start
        </template>
      </button>
      <div
        v-if="loadingItems.length > 0 && isLoading"
        bottom="20" left="1/2" translate-x="-50%" max-w="50"
        absolute z-10 h-5 w-full
      >
        <Progress :percentage="Math.min(100, overallProgress)" />
      </div>

      <div
        v-for="(item, index) in detectedObjects" :key="index"
        fixed
        :style="{
          top: `${item.box.ymin}px`,
          left: `${item.box.xmin}px`,
          width: `${item.box.xmax - item.box.xmin}px`,
          height: `${item.box.ymax - item.box.ymin}px`,
          zIndex: 100 + 100 * index,
        }"
        :data-box="JSON.stringify(item.box)"
        class="box-content border-4 rounded-lg"
        :class="[
          borderColorSets[index % borderColorSets.length],
        ]"
      >
        <div
          px-2 pb-2 pt-1 text-white font-mono
          :class="[bgColorSets[index % bgColorSets.length]]"
        >
          {{ item.label }} ({{ item.score.toFixed(2) }})
        </div>
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
