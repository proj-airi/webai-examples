<script setup lang="ts">
import { useAudio } from '../composables/useAudio'
import { useCombinedMode } from '../composables/useCombinedMode'
import { useVision } from '../composables/useVision'

// Get data directly from composables
const audio = useAudio()
const combined = useCombinedMode()
const vision = useVision()

// Event handlers
function handleStartSession() {
  combined.startCombinedSession()
}

function handleStopSession() {
  combined.stopCombinedSession()
}
</script>

<template>
  <div class="w-[400px] flex flex-col items-center justify-center rounded-r-xl bg-white p-8 shadow-lg space-y-6">
    <!-- Voice Selection -->
    <div class="w-full">
      <div class="mb-2 flex justify-between text-xl text-green-700 font-bold">
        {{ audio.voices.value[audio.voice.value]?.name || 'Voice Assistant' }}
        <span class="text-gray-500 font-normal">{{ combined.elapsedTime.value }}</span>
      </div>
      <div class="relative">
        <button
          type="button"
          :disabled="!audio.audioReady.value"
          class="w-full flex items-center justify-between border border-gray-300 rounded-md px-3 py-2 transition-colors"
          :class="[
            audio.audioReady.value ? 'bg-transparent hover:border-gray-400' : 'bg-gray-100 opacity-50 cursor-not-allowed',
          ]"
        >
          <span>Select voice</span>
          <div class="i-lucide-chevron-down" />
        </button>
        <select
          v-model="audio.voice.value"
          class="absolute inset-0 cursor-pointer opacity-0"
          :disabled="!audio.audioReady.value"
        >
          <option v-for="[key, v] in Object.entries(audio.voices.value)" :key="key" :value="key">
            {{ `${v.name} (${v.language === 'en-us' ? 'American' : v.language} ${v.gender})` }}
          </option>
        </select>
      </div>
    </div>

    <!-- Visual Indicator -->
    <div class="relative aspect-square h-32 w-32 flex flex-shrink-0 items-center justify-center">
      <template v-if="combined.combinedMode.value">
        <div
          v-for="id in combined.ripples.value"
          :key="id"
          class="pointer-events-none absolute inset-0 animate-ping border-2 border-green-200 rounded-full"
          style="animation: ripple 1.5s ease-out forwards"
        />
      </template>

      <!-- Pulsing loader while initializing -->
      <div
        class="absolute h-32 w-32 rounded-full transition-all duration-300"
        :class="[
          audio.audioError.value ? 'bg-red-200' : 'bg-green-200',
          !audio.audioReady.value ? 'animate-ping opacity-75' : '',
        ]"
      />

      <!-- Main rings -->
      <div
        class="absolute h-32 w-32 rounded-full shadow-inner transition-transform duration-300 ease-out"
        :class="[
          audio.audioError.value ? 'bg-red-300' : 'bg-green-300',
          !audio.audioReady.value ? 'opacity-0' : '',
        ]"
        :style="{ transform: `scale(${audio.speakingScale.value})` }"
      />
      <div
        class="absolute h-32 w-32 rounded-full shadow-inner transition-transform duration-300 ease-out"
        :class="[
          audio.audioError.value ? 'bg-red-200' : 'bg-green-200',
          !audio.audioReady.value ? 'opacity-0' : '',
        ]"
        :style="{ transform: `scale(${audio.listeningScale.value})` }"
      />

      <!-- Center text -->
      <div
        class="absolute z-10 text-center text-lg"
        :class="[audio.audioError.value ? 'text-red-700' : 'text-gray-700']"
      >
        <template v-if="audio.audioError.value">
          {{ audio.audioError.value }}
        </template>
        <template v-else>
          <template v-if="!audio.audioReady.value">
            Loading...
          </template>
          <template v-else-if="audio.isListening.value">
            Listening...
          </template>
          <template v-else-if="audio.isSpeaking.value">
            Speaking...
          </template>
          <template v-else-if="combined.combinedMode.value">
            Ready
          </template>
          <template v-else>
            Click Start
          </template>
        </template>
      </div>
    </div>

    <!-- Instructions -->
    <div v-if="!combined.combinedMode.value" class="max-w-xs text-center text-sm text-gray-600">
      <p class="mb-2">
        Start a session to ask questions about what you see through the camera.
      </p>
      <p class="text-xs opacity-75">
        The AI will analyze the video feed and respond to your voice commands.
      </p>
    </div>

    <!-- Action Button -->
    <button
      v-if="combined.combinedMode.value"
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
        audio.audioReady.value && vision.visionLoaded.value ? 'bg-blue-100 text-blue-700 hover:bg-blue-200' : 'bg-blue-100 text-blue-700 opacity-50 cursor-not-allowed',
      ]"
      :disabled="!audio.audioReady.value || (vision.isWebGPULoading.value || vision.isModelLoading.value)"
      @click="handleStartSession"
    >
      <template v-if="vision.isWebGPULoading.value || vision.isModelLoading.value">
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
