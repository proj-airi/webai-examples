<script setup lang="ts">
import type { ObjectDetectionPipelineSingle } from '@huggingface/transformers'

import { sleep } from '@moeru/std/sleep'
import { useDark, useDevicesList, useElementBounding, useUserMedia } from '@vueuse/core'
import { check } from 'gpuu/webgpu'
import { computed, onMounted, ref, watch } from 'vue'

import Progress from './components/Progress.vue'
import { useTransformersWorker } from './composables/use-transformers-worker'
import workerURL from './workers/yolov9-worker?worker&url'

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

const intervalSelect = ref('5')

const loaded = ref(false)
const isProcessing = ref(false)
const isWebGPULoading = ref(false)
const isWebGPUSupported = ref(true)

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

function captureImage() {
  if (!stream || !videoScreen.value?.videoWidth || !captureCanvas.value) {
    console.warn('Video stream not ready for capture.')
    return null
  }

  const { width, height } = videoScreen.value?.getBoundingClientRect()
  captureCanvas.value.width = width
  captureCanvas.value.height = height

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
    // TODO: display error message
    return
  }
  try {
    const response = await process({
      imageBuffer: rawImg.imageBuffer,
      imageWidth: rawImg.imageWidth,
      imageHeight: rawImg.imageHeight,
      channels: rawImg.channels,
    })
    // TODO: display detected result
    if (response && response.length > 0) {
      detectedObjects.value = response.map(item => ({
        box: {
          xmin: item.box.xmin,
          ymin: item.box.ymin,
          xmax: item.box.xmax,
          ymax: item.box.ymax,
        },
        label: item.label,
        score: item.score,
      }))
    }
    else {
      detectedObjects.value = []
    }
  }
  catch (e) {
    console.error(e)
    // TODO: display error message
  }
}

async function processingLoop() {
  const intervalMs = Number.parseInt(intervalSelect.value, 10)
  while (isProcessing.value) {
    await sendData()
    if (!isProcessing.value)
      break
    await sleep(intervalMs)
  }
}

async function handleStart() {
  if (!stream) {
    // TODO: ?
    // eslint-disable-next-line no-alert
    alert('Camera not available. Please grant permission first.')
    return
  }

  if (!loaded.value) {
    isWebGPULoading.value = true
    await load()
    isWebGPULoading.value = false
    loaded.value = true
  }

  isProcessing.value = true
  // TODO: ?
  processingLoop()
}

function handleStop() {
  isProcessing.value = false
  // if (responseText.value === '...') {
  //   responseText.value = ''
  // }
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
        <canvas ref="captureCanvas" class="hidden" />
        <video ref="videoScreen" autoplay muted relative z-0 h-full w-full object-cover />
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
