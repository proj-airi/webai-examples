<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'

import { INPUT_SAMPLE_RATE } from './constants'
import WORKLET_URL from './workers/play-worklet?worker&url'
import VAD_WORKLET_URL from './workers/vad-processor?worker&url'
import WORKER_URL from './workers/worker?url'

interface Voice {
  name: string
  language: string
  gender: string
}

interface VoiceMap {
  [key: string]: Voice
}

interface WorkerMessage {
  type: string
  status?: string
  voices?: VoiceMap
  error?: Error
  result?: {
    audio: Float32Array
  }
}

const callStartTime = ref<number | null>(null)
const callStarted = ref<boolean>(false)
const playing = ref<boolean>(false)

const voice = ref<string>('af_heart')
const voices = ref<VoiceMap>({})

const isListening = ref<boolean>(false)
const isSpeaking = ref<boolean>(false)
const listeningScale = ref<number>(1)
const speakingScale = ref<number>(1)
const ripples = ref<number[]>([])

const ready = ref<boolean>(false)
const error = ref<string | null>(null)
const elapsedTime = ref<string>('00:00')
const worker = ref<Worker | null>(null)

const micStreamRef = ref<MediaStream | null>(null)
const node = ref<AudioWorkletNode | null>(null)

watch(voice, () => {
  worker.value?.postMessage({
    type: 'set_voice',
    voice: voice.value,
  })
})

watch(callStarted, () => {
  if (!callStarted.value) {
    // Reset worker state after call ends
    worker.value?.postMessage({
      type: 'end_call',
    })
  }
})

watch(callStarted, () => {
  if (callStarted.value && callStartTime.value) {
    const interval = setInterval(() => {
      const diff = Math.floor((Date.now() - callStartTime.value!) / 1000)
      const minutes = String(Math.floor(diff / 60)).padStart(2, '0')
      const seconds = String(diff % 60).padStart(2, '0')
      elapsedTime.value = `${minutes}:${seconds}`
    }, 1000)
    return () => clearInterval(interval)
  }
  else {
    elapsedTime.value = '00:00'
  }
})

onMounted(() => {
  worker.value ??= new Worker(WORKER_URL, {
    type: 'module',
  })

  const onError = (err: Error): void => {
    error.value = err.message
  }

  const onMessage = ({ data }: { data: WorkerMessage }): void => {
    if (data.error) {
      return onError(data.error)
    }

    switch (data.type) {
      case 'status':
        if (data.status === 'recording_start') {
          isListening.value = true
          isSpeaking.value = false
        }
        else if (data.status === 'recording_end') {
          isListening.value = false
        }
        else if (data.status === 'ready') {
          voices.value = data.voices || {}
          ready.value = true
        }
        break
      case 'output':
        if (!playing.value && node.value && data.result) {
          node.value.port.postMessage(data.result.audio)
          playing.value = true
          isSpeaking.value = true
          isListening.value = false
        }
        break
    }
  }

  worker.value.addEventListener('message', onMessage)
  worker.value.addEventListener('error', (event: ErrorEvent) => onError(event.error))

  return () => {
    worker.value?.removeEventListener('message', onMessage)
    worker.value?.removeEventListener('error', (event: ErrorEvent) => onError(event.error))
  }
})

watch(callStarted, () => {
  if (!callStarted.value)
    return

  let worklet: AudioWorkletNode | undefined
  let inputAudioContext: AudioContext | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let ignore = false

  let outputAudioContext: AudioContext | undefined
  const audioStreamPromise = Promise.resolve(micStreamRef.value)

  audioStreamPromise
    .then(async (stream) => {
      if (ignore || !stream)
        return

      inputAudioContext = new AudioContext({
        sampleRate: INPUT_SAMPLE_RATE,
      })

      const analyser = inputAudioContext.createAnalyser()
      analyser.fftSize = 256
      source = inputAudioContext.createMediaStreamSource(stream)
      source.connect(analyser)

      const inputDataArray = new Uint8Array(analyser.frequencyBinCount)

      function calculateRMS(array: Uint8Array): number {
        let sum = 0
        for (let i = 0; i < array.length; ++i) {
          const normalized = array[i] / 128 - 1
          sum += normalized * normalized
        }
        const rms = Math.sqrt(sum / array.length)
        return rms
      }

      await inputAudioContext.audioWorklet.addModule(
        VAD_WORKLET_URL,
      )
      worklet = new AudioWorkletNode(inputAudioContext, 'vad-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete',
      })

      source.connect(worklet)
      worklet.port.onmessage = (event: MessageEvent) => {
        const { buffer } = event.data
        worker.value?.postMessage({ type: 'audio', buffer })
      }

      outputAudioContext = new AudioContext({
        sampleRate: 24000,
      })
      outputAudioContext.resume()

      await outputAudioContext.audioWorklet.addModule(new URL(WORKLET_URL, import.meta.url))

      node.value = new AudioWorkletNode(
        outputAudioContext,
        'buffered-audio-worklet-processor',
      )

      node.value.port.onmessage = (event: MessageEvent) => {
        if (event.data.type === 'playback_ended') {
          playing.value = false
          isSpeaking.value = false
          worker.value?.postMessage({ type: 'playback_ended' })
        }
      }

      const outputAnalyser = outputAudioContext.createAnalyser()
      outputAnalyser.fftSize = 256

      node.value.connect(outputAnalyser)
      outputAnalyser.connect(outputAudioContext.destination)

      const outputDataArray = new Uint8Array(
        outputAnalyser.frequencyBinCount,
      )

      function updateVisualizers() {
        analyser.getByteTimeDomainData(inputDataArray)
        const rms = calculateRMS(inputDataArray)
        const targetScale = 1 + Math.min(1.25 * rms, 0.25)
        listeningScale.value += (targetScale - listeningScale.value) * 0.25

        outputAnalyser.getByteTimeDomainData(outputDataArray)
        const outputRMS = calculateRMS(outputDataArray)
        const targetOutputScale = 1 + Math.min(1.25 * outputRMS, 0.25)
        speakingScale.value += (targetOutputScale - speakingScale.value) * 0.25

        requestAnimationFrame(updateVisualizers)
      }
      updateVisualizers()
    })
    .catch((err: Error) => {
      error.value = err.message
      console.error(err)
    })

  return () => {
    ignore = true
    audioStreamPromise.then(s => s?.getTracks().forEach(t => t.stop()))
    source?.disconnect()
    worklet?.disconnect()
    inputAudioContext?.close()
    outputAudioContext?.close()
  }
})

watch(callStarted, () => {
  if (!callStarted.value)
    return
  const interval = setInterval(() => {
    const id = Date.now()
    ripples.value = [...ripples.value, id]
    setTimeout(() => {
      ripples.value = ripples.value.filter(r => r !== id)
    }, 1500)
  }, 1000)
  return () => clearInterval(interval)
})

async function handleStartCall(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: true,
        sampleRate: INPUT_SAMPLE_RATE,
      },
    })
    micStreamRef.value = stream

    callStartTime.value = Date.now()
    callStarted.value = true
    worker.value?.postMessage({ type: 'start_call' })
  }
  catch (err) {
    if (err instanceof Error) {
      error.value = err.message
      console.error(err)
    }
  }
}
</script>

<template>
  <div class="relative h-screen min-h-[240px] flex items-center justify-center bg-gray-50 p-4">
    <div class="h-full max-h-[320px] w-[640px] flex items-center justify-between rounded-xl bg-white p-8 shadow-lg space-x-16">
      <div class="w-[140px] text-green-700">
        <div class="flex justify-between text-xl font-bold">
          {{ voices[voice]?.name }}
          <span class="text-gray-500 font-normal">{{ elapsedTime }}</span>
        </div>
        <div class="relative text-base">
          <button
            type="button"
            :disabled="!ready"
            class="w-full flex items-center justify-between border border-gray-300 rounded-md transition-colors" :class="[
              ready ? 'bg-transparent hover:border-gray-400' : 'bg-gray-100 opacity-50 cursor-not-allowed',
            ]"
          >
            <span class="px-2 py-1">Select voice</span>
            <i i-lucide-chevron-down class="absolute right-2" />
          </button>
          <select
            v-model="voice"
            class="absolute inset-0 cursor-pointer opacity-0"
            :disabled="!ready"
          >
            <option v-for="[key, v] in Object.entries(voices)" :key="key" :value="key">
              {{ `${v.name} (${v.language === 'en-us' ? 'American' : v.language} ${v.gender})` }}
            </option>
          </select>
        </div>
      </div>

      <div class="relative aspect-square h-32 w-32 flex flex-shrink-0 items-center justify-center">
        <template v-if="callStarted">
          <div
            v-for="id in ripples"
            :key="id"
            class="pointer-events-none absolute inset-0 border-2 border-green-200 rounded-full"
            style="animation: ripple 1.5s ease-out forwards"
          />
        </template>
        <!-- Pulsing loader while initializing -->
        <div
          class="absolute h-32 w-32 rounded-full" :class="[
            error ? 'bg-red-200' : 'bg-green-200',
            !ready ? 'animate-ping opacity-75' : '',
          ]"
          style="animation-duration: 1.5s"
        />
        <!-- Main rings -->
        <div
          class="absolute h-32 w-32 rounded-full shadow-inner transition-transform duration-300 ease-out" :class="[
            error ? 'bg-red-300' : 'bg-green-300',
            !ready ? 'opacity-0' : '',
          ]"
          :style="{ transform: `scale(${speakingScale})` }"
        />
        <div
          class="absolute h-32 w-32 rounded-full shadow-inner transition-transform duration-300 ease-out" :class="[
            error ? 'bg-red-200' : 'bg-green-200',
            !ready ? 'opacity-0' : '',
          ]"
          :style="{ transform: `scale(${listeningScale})` }"
        />
        <!-- Center text: show error if present, else existing statuses -->
        <div
          class="absolute z-10 text-center text-lg" :class="[
            error ? 'text-red-700' : 'text-gray-700',
          ]"
        >
          <template v-if="error">
            {{ error }}
          </template>
          <template v-else>
            <template v-if="!ready">
              Loading...
            </template>
            <template v-if="isListening">
              Listening...
            </template>
            <template v-if="isSpeaking">
              Speaking...
            </template>
          </template>
        </div>
      </div>

      <div class="w-[140px] space-y-4">
        <button
          v-if="callStarted"
          class="flex items-center rounded-md bg-red-100 px-4 py-2 text-red-700 space-x-2 hover:bg-red-200"
          @click="() => {
            callStarted = false;
            callStartTime = null;
            playing = false;
            isListening = false;
            isSpeaking = false;
          }"
        >
          <i i-lucide-phone-off class="h-5 w-5" />
          <span>End call</span>
        </button>
        <button
          v-else
          class="flex items-center rounded-md px-4 py-2 space-x-2" :class="[
            ready ? 'bg-blue-100 text-blue-700 hover:bg-blue-200' : 'bg-blue-100 text-blue-700 opacity-50 cursor-not-allowed',
          ]"
          :disabled="!ready"
          @click="handleStartCall"
        >
          <span>Start call</span>
        </button>
      </div>
    </div>

    <div class="absolute bottom-4 text-sm">
      Built with
      <a
        href="https://github.com/huggingface/transformers.js"
        rel="noopener noreferrer"
        target="_blank"
        class="text-blue-600 hover:underline"
      >
        🤗 Transformers.js
      </a>
    </div>
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
