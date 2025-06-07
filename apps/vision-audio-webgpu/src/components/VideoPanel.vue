<script setup lang="ts">
import type { Ref } from 'vue'

import { useDark } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { inject } from 'vue'

import { useVisionStore } from '../composables/useVision'
import Progress from './Progress.vue'
import Range from './Range.vue'

// Interface for captured image
interface CapturedImage {
  imageBuffer: Uint8ClampedArray
  imageWidth: number
  imageHeight: number
  channels: 1 | 2 | 3 | 4
}

// Type for combined mode state and functions
interface CombinedMode {
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

// Get data directly from composables
const vision = storeToRefs(useVisionStore())
const isDark = useDark({ disableTransition: false })

// Inject combined mode state from parent App.vue
const combined = inject<CombinedMode>('combined')
</script>

<template>
  <div class="relative flex-1">
    <!-- Video Stream -->
    <div class="relative h-full w-full overflow-hidden rounded-l-xl shadow-lg">
      <!-- Header -->
      <div class="absolute left-0 top-0 z-10 flex gap-2 p-4">
        <div
          class="border border-neutral-400/40 rounded-xl bg-white/90 px-3 py-2 text-black backdrop-blur-sm dark:border-neutral-500/50 dark:bg-neutral-900/90 dark:text-white"
        >
          Vision + Audio WebGPU
        </div>
        <a
          href="https://github.com/proj-airi/webai-examples"
          class="flex items-center justify-center border border-neutral-400/40 rounded-xl bg-white/90 px-3 py-2 text-black backdrop-blur-sm dark:border-neutral-500/50 dark:bg-neutral-900/90 hover:bg-neutral-100/90 dark:text-white dark:hover:bg-neutral-800/90"
        >
          <div class="i-simple-icons:github size-4" />
        </a>
      </div>

      <!-- Performance Monitor -->
      <div
        v-if="combined?.combinedMode.value"
        class="absolute left-4 top-16 z-10 flex gap-2 border border-neutral-400/40 rounded-xl bg-white/80 px-3 py-2 text-sm text-black backdrop-blur-sm dark:border-neutral-500/50 dark:bg-neutral-900/80 dark:text-white"
      >
        <span>FPS: <span class="font-mono">{{ vision.fpsCounter.value }}</span></span>
        <span>Time: <span class="font-mono">{{ vision.processingTime.value }}ms</span></span>
      </div>

      <!-- Vision Controls -->
      <div
        v-if="combined?.combinedMode.value"
        class="absolute bottom-4 left-4 z-10 grid grid-cols-[0.3fr_0.4fr_0.3fr] min-w-[280px] items-center gap-x-2 gap-y-1 border border-neutral-400/40 rounded-xl bg-neutral-500/40 px-3 py-2 text-sm text-white/98 backdrop-blur-lg dark:border-neutral-500/50 dark:bg-neutral-900/70 dark:text-neutral-100/90"
      >
        <!-- Scale Control -->
        <div>Scale:</div>
        <Range
          v-model="vision.scale.value"
          :min="0.1"
          :max="1.0"
          :step="0.1"
          :disabled="!combined?.combinedMode.value"
          class="flex-1"
        />
        <div class="text-right font-mono">
          {{ vision.scale.value.toFixed(1) }}
        </div>

        <!-- Max Size Control -->
        <div>Max Size:</div>
        <Range
          v-model="vision.maxImageSize.value"
          :min="128"
          :max="512"
          :step="32"
          :disabled="!combined?.combinedMode.value"
          class="flex-1"
        />
        <div class="text-right font-mono">
          {{ vision.maxImageSize.value }}
        </div>

        <!-- Instruction -->
        <div class="col-span-3 mt-2">
          <label class="text-xs opacity-75">Question:</label>
          <input
            v-model="vision.instructionText.value"
            placeholder="What do you see?"
            type="text"
            :disabled="!combined?.combinedMode.value"
            class="mt-1 w-full border border-neutral-500/50 rounded-lg bg-neutral-700/50 px-2 py-1 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-950 dark:focus:border-neutral-500"
          >
        </div>
      </div>

      <!-- Response Display -->
      <div
        v-if="vision.responseText.value && combined?.combinedMode.value"
        class="absolute bottom-20 left-1/2 z-10 max-w-[80%] transform border border-neutral-400/40 rounded-xl bg-neutral-700/80 px-3 py-2 text-center text-white/98 backdrop-blur-lg -translate-x-1/2 dark:border-neutral-500/50 dark:bg-neutral-900/90 dark:text-neutral-100/90"
      >
        {{ vision.responseText.value }}
      </div>

      <!-- Loading Progress -->
      <div
        v-if="vision.loadingItems.value.length > 0 && vision.isModelLoading.value"
        class="absolute bottom-20 left-1/2 z-10 h-5 max-w-[50%] w-full transform -translate-x-1/2"
      >
        <Progress :percentage="Math.min(100, vision.overallProgress.value)" />
      </div>

      <!-- Camera Controls -->
      <div class="absolute bottom-4 right-4 z-10 flex items-center gap-2">
        <select
          v-model="vision.videoSourceDeviceId.value"
          class="cursor-pointer border border-neutral-400/40 rounded-full bg-neutral-500/40 px-3 py-2 text-sm text-white/98 outline-none backdrop-blur-lg dark:border-neutral-500/50 dark:bg-neutral-900/70 hover:bg-neutral-600/40 dark:text-neutral-100/90 hover:dark:bg-neutral-900/60"
        >
          <option
            v-for="device in vision.videoInputs.value"
            :key="device.deviceId"
            :value="device.deviceId"
          >
            {{ device.label }}
          </option>
        </select>
        <button
          class="aspect-square flex items-center justify-center border border-neutral-400/40 rounded-full bg-neutral-500/40 p-2 text-white/98 backdrop-blur-lg dark:border-neutral-500/50 dark:bg-neutral-900/70 hover:bg-neutral-600/40 dark:text-neutral-100/90 hover:dark:bg-neutral-900/60"
          @click="isDark = !isDark"
        >
          <Transition name="fade" mode="out-in">
            <div v-if="isDark" class="i-solar:moon-stars-bold size-4" />
            <div v-else class="i-solar:sun-bold size-4" />
          </Transition>
        </button>
      </div>

      <!-- Capability Checks -->
      <div v-if="!vision.isSupported.value" class="absolute inset-0 z-10 flex flex-col items-center justify-center bg-neutral-50/80 dark:bg-neutral-900/80">
        <div class="text-4xl text-neutral-700 font-semibold dark:text-neutral-300">
          Not Supported
        </div>
        <div class="max-w-[50%] text-center text-2xl text-neutral-600 dark:text-neutral-400">
          Browser does not support video camera. Please use a supported browser.
        </div>
      </div>
      <div v-else-if="!vision.isWebGPUSupported.value" class="absolute inset-0 z-10 flex flex-col items-center justify-center bg-neutral-50/80 dark:bg-neutral-900/80">
        <div class="text-4xl text-neutral-700 font-semibold dark:text-neutral-300">
          Not Supported
        </div>
        <div class="max-w-[50%] text-center text-2xl text-neutral-600 dark:text-neutral-400">
          Browser does not support WebGPU. Please use a supported browser.
        </div>
      </div>
      <div v-else-if="!vision.permissionGranted.value" class="absolute inset-0 z-10 flex flex-col items-center justify-center bg-orange-50/80 dark:bg-orange-900/20">
        <div class="text-4xl text-orange-700 font-semibold">
          Warning
        </div>
        <div class="max-w-[50%] text-center text-2xl text-orange-600">
          Permission not granted. Please grant permission first.
        </div>
      </div>
      <template v-else>
        <slot name="video-element" />
      </template>
    </div>
  </div>
</template>

<style scoped>
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
