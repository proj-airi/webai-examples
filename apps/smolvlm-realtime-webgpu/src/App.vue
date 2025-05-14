<script setup lang="ts">
import type { LoadOptionProgressCallback, ProgressInfo, ProgressStatusInfo } from '@xsai-transformers/shared/types'

import { useDark, useDevicesList, useElementBounding, useUserMedia } from '@vueuse/core'
import { check } from 'gpuu/webgpu'
import { computed, onMounted, onUnmounted, ref, toRef, watch } from 'vue'

import Progress from './components/Progress.vue'
import { dispose, load, process } from './libs/vlm'

const { videoInputs, permissionGranted, isSupported } = useDevicesList({ constraints: { video: true, audio: false }, requestPermissions: true })

const videoScreenContainer = ref<HTMLDivElement>()
const videoScreen = ref<HTMLVideoElement>()
const captureCanvas = ref<HTMLCanvasElement>()

const selectedVideoSourceDeviceId = toRef(() => videoInputs.value[0]?.deviceId)
const constraints = computed(() => ({ video: { deviceId: selectedVideoSourceDeviceId.value } }))

const loaded = ref(false)
const isProcessing = ref(false)
const instructionText = ref('In one sentence, what do you see?')
const responseText = ref('')
const intervalSelect = ref('1000')
const isWebGPUSupported = ref(true)

const loadingItems = ref<ProgressInfo[]>([])
const loadingItemsSet = new Set<string>()
const overallProgress = ref(0)
const overallTotal = ref(0)
const isLoading = ref(false)

const isDark = useDark({ disableTransition: false })
const videoScreenContainerBounding = useElementBounding(videoScreenContainer, { immediate: true, windowResize: true })
const { stream, start } = useUserMedia({ constraints, enabled: true, autoSwitch: true })

function captureImage() {
  if (!stream || !videoScreen.value?.videoWidth || !captureCanvas.value) {
    console.warn('Video stream not ready for capture.')
    return null
  }

  captureCanvas.value.width = videoScreen.value?.videoWidth
  captureCanvas.value.height = videoScreen.value?.videoHeight
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
    const response = await process({
      instruction,
      imageBuffer: rawImg.imageBuffer,
      imageWidth: rawImg.imageWidth,
      imageHeight: rawImg.imageHeight,
      channels: rawImg.channels,
    })

    responseText.value = response.data ?? ''
  }
  catch (e) {
    console.error(e)
    responseText.value = `Error: ${e instanceof Error ? e.message : 'Unknown error'}`
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
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

const onProgress: LoadOptionProgressCallback = async (progress) => {
  if (progress.status === 'initiate') {
    // New file discovered
    if (loadingItemsSet.has(progress.file)) {
      return
    }

    loadingItemsSet.add(progress.file)
    loadingItems.value.push(progress)
    isLoading.value = true
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
      isLoading.value = false
      // Set progress to 100% when done
      overallProgress.value = 100
    }
  }
  else if (progress.status === 'ready') {
    isLoading.value = false
    // Set progress to 100% when ready
    overallProgress.value = 100
  }
}

async function handleStart() {
  if (!stream) {
    responseText.value = 'Camera not available. Cannot start.'
    // eslint-disable-next-line no-alert
    alert('Camera not available. Please grant permission first.')
    return
  }

  if (!loaded.value) {
    await load({ onProgress })
    loaded.value = true
  }

  isProcessing.value = true
  responseText.value = '...'
  processingLoop()
}

function handleStop() {
  isProcessing.value = false
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

onMounted(videoScreenContainerBounding.update)
onUnmounted(() => dispose())
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
        {{ isProcessing ? 'Stop' : 'Start' }}
      </button>
      <div
        v-if="loadingItems.length > 0 && isLoading"
        bottom="20" left="1/2" translate-x="-50%" max-w="50"
        absolute z-10 h-10 w-full
      >
        <Progress :percentage="Math.min(100, overallProgress)" />
      </div>
      <div
        v-if="responseText"
        translate-x="-50%" absolute bottom="20" left="1/2" z-10
        bg="neutral-700/60 dark:neutral-900/90"
        text="white/98 dark:neutral-100/90 <sm:xs"
        border="neutral-400/40 dark:neutral-500/50 1 solid"
        transition="all duration-300 ease-in-out"
        class="rounded-xl px-2 py-1 sm:rounded-2xl sm:px-3 sm:py-2"
        backdrop-blur-lg
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
          v-model="selectedVideoSourceDeviceId"
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
