<script setup lang="ts">
import type { Ref } from 'vue'

import { storeToRefs } from 'pinia'
import { inject } from 'vue'

import { useAudioStore } from '../composables/use-audio'
import { useVisionStore } from '../composables/use-vision'

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
const { voices, audioReady, voice, audioError, speakingScale, listeningScale, isListening, isSpeaking } = storeToRefs(useAudioStore())
const { visionLoaded, isWebGPULoading, isModelLoading } = storeToRefs(useVisionStore())

// Inject combined mode state and functions from parent App.vue
const combined = inject<CombinedMode>('combined')

// Event handlers
function handleStartSession() {
  combined?.startCombinedSession()
}

function handleStopSession() {
  combined?.stopCombinedSession()
}
</script>

<template>
  <div class="w-[400px] flex flex-col items-center justify-center rounded-r-xl bg-white p-8 shadow-lg space-y-6">
    <code>
      {{ audioReady }}
    </code>

    <!-- Voice Selection -->
    <div class="w-full">
      <div class="mb-2 flex justify-between text-xl text-green-700 font-bold">
        {{ voices[voice]?.name || 'Voice Assistant' }}
        <span class="text-gray-500 font-normal">{{ combined?.elapsedTime.value || '00:00' }}</span>
      </div>
      <div class="relative">
        <button
          type="button"
          :disabled="!audioReady"
          class="w-full flex items-center justify-between border border-gray-300 rounded-md px-3 py-2 transition-colors"
          :class="[
            audioReady ? 'bg-transparent hover:border-gray-400' : 'bg-gray-100 opacity-50 cursor-not-allowed',
          ]"
        >
          <span>Select voice</span>
          <div class="i-lucide-chevron-down" />
        </button>
        <select
          v-model="voice"
          class="absolute inset-0 cursor-pointer opacity-0"
          :disabled="!audioReady"
        >
          <option v-for="[key, v] in Object.entries(voices)" :key="key" :value="key">
            {{ `${v.name} (${v.language === 'en-us' ? 'American' : v.language} ${v.gender})` }}
          </option>
        </select>
      </div>
    </div>

    <!-- Visual Indicator -->
    <div class="relative aspect-square h-32 w-32 flex flex-shrink-0 items-center justify-center">
      <template v-if="combined?.combinedMode.value">
        <div
          v-for="id in combined?.ripples.value || []"
          :key="id"
          class="pointer-events-none absolute inset-0 animate-ping border-2 border-green-200 rounded-full"
          style="animation: ripple 1.5s ease-out forwards"
        />
      </template>

      <!-- Pulsing loader while initializing -->
      <div
        class="absolute h-32 w-32 rounded-full transition-all duration-300"
        :class="[
          audioError ? 'bg-red-200' : 'bg-green-200',
          !audioReady ? 'animate-ping opacity-75' : '',
        ]"
      />

      <!-- Main rings -->
      <div
        class="absolute h-32 w-32 rounded-full shadow-inner transition-transform duration-300 ease-out"
        :class="[
          audioError ? 'bg-red-300' : 'bg-green-300',
          !audioReady ? 'opacity-0' : '',
        ]"
        :style="{ transform: `scale(${speakingScale})` }"
      />
      <div
        class="absolute h-32 w-32 rounded-full shadow-inner transition-transform duration-300 ease-out"
        :class="[
          audioError ? 'bg-red-200' : 'bg-green-200',
          !audioReady ? 'opacity-0' : '',
        ]"
        :style="{ transform: `scale(${listeningScale})` }"
      />

      <!-- Center text -->
      <div
        class="absolute z-10 text-center text-lg"
        :class="[audioError ? 'text-red-700' : 'text-gray-700']"
      >
        <template v-if="audioError">
          {{ audioError }}
        </template>
        <template v-else>
          <template v-if="!audioReady">
            Loading...
          </template>
          <template v-else-if="isListening">
            Listening...
          </template>
          <template v-else-if="isSpeaking">
            Speaking...
          </template>
          <template v-else-if="combined?.combinedMode.value">
            Ready
          </template>
          <template v-else>
            Click Start
          </template>
        </template>
      </div>
    </div>

    <!-- Instructions -->
    <div v-if="!combined?.combinedMode.value" class="max-w-xs text-center text-sm text-gray-600">
      <p class="mb-2">
        Start a session to ask questions about what you see through the camera.
      </p>
      <p class="text-xs opacity-75">
        The AI will analyze the video feed and respond to your voice commands.
      </p>
    </div>

    <!-- Action Button -->
    <button
      v-if="combined?.combinedMode.value"
      class="flex items-center rounded-md bg-red-100 px-6 py-3 text-red-700 transition-colors space-x-2 hover:bg-red-200"
      @click="handleStopSession"
    >
      <div class="i-lucide-phone-off h-5 w-5" />
      <span>End Session</span>
    </button>
    <button
      v-else
      class="flex items-center rounded-md px-6 py-3 transition-colors space-x-2"
      :class="[
        audioReady && visionLoaded ? 'bg-blue-100 text-blue-700 hover:bg-blue-200' : 'bg-blue-100 text-blue-700 opacity-50 cursor-not-allowed',
      ]"
      :disabled="!audioReady || (isWebGPULoading || isModelLoading)"
      @click="handleStartSession"
    >
      <template v-if="isWebGPULoading || isModelLoading">
        <div class="i-svg-spinners:6-dots-rotate size-4" />
        <span>Loading...</span>
      </template>
      <template v-else>
        <div class="i-lucide-video h-5 w-5" />
        <span>Start Session</span>
      </template>
    </button>
  </div>
</template>

<style scoped>
@keyframes ripple {
  from {
    transform: scale(1);
    opacity: 0.7;
  }
  to {
    transform: scale(2);
    opacity: 0;
  }
}
</style>
