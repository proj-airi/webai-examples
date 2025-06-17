<script setup lang="ts">
import { converter, formatRgb, oklch } from 'culori'
import { onMounted, ref, watch } from 'vue'

import type { VoiceName, Voices } from './types/kokoro'
import type { WorkerMessageEvent } from './types/worker'

import { Carousel, CarouselContent, CarouselItem } from './components/Carousel'
import { INPUT_SAMPLE_RATE } from './constants'
import WORKLET_URL from './workers/play-worklet?worker&url'
import VAD_WORKLET_URL from './workers/vad-processor?worker&url'
import WORKER_URL from './workers/worker?url'

const loading = ref<boolean>(false)
const callStartTime = ref<number | null>(null)
const callStarted = ref<boolean>(false)
const playing = ref<boolean>(false)

const voice = ref<VoiceName>('af_heart')
const voices = ref<Voices>({} as Voices)

const isListening = ref<boolean>(false)
const isSpeaking = ref<boolean>(false)
const listeningScale = ref<number>(1)
const speakingScale = ref<number>(1)
const ripples = ref<number[]>([])

const errored = ref(false)
const error = ref<string>('')
const initializationErrored = ref<boolean>(false)
const initializationError = ref<string>('')

const modelsInitialized = ref<boolean>(false)
const elapsedTime = ref<string>('00:00')
const worker = ref<Worker | null>(null)

const micStreamRef = ref<MediaStream | null>(null)
const node = ref<AudioWorkletNode | null>(null)

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
  callStarted.value = true

  loading.value = true

  try {
    worker.value ??= new Worker(WORKER_URL, {
      type: 'module',
    })

    const onError = (err: Error | unknown): void => {
      if (!callStarted.value) {
        initializationErrored.value = true
        initializationError.value = err instanceof Error ? err.message : String(err)
      }

      errored.value = true
      error.value = err instanceof Error ? err.message : String(err)
    }

    const onMessage = ({ data }: { data: WorkerMessageEvent }): void => {
      switch (data.type) {
        case 'error':
          loading.value = false

          return onError(data.data.error)
        case 'status':
          if (data.data.status === 'recording_start') {
            isListening.value = true
            isSpeaking.value = false
          }
          else if (data.data.status === 'recording_end') {
            isListening.value = false
          }
          else if (data.data.status === 'ready') {
            voices.value = data.data.voices || {} as Voices
            modelsInitialized.value = true
            loading.value = false
          }

          break
        case 'output':
          if (!playing.value && node.value && data.data.result) {
            node.value.port.postMessage(data.data.result.audio)
            playing.value = true
            isSpeaking.value = true
            isListening.value = false
          }

          break
        case 'set_voice_response':
          handleDial()
          break
      }
    }

    worker.value.addEventListener('message', onMessage)
    worker.value.addEventListener('error', (event: ErrorEvent) => {
      onError(event.error)
      loading.value = false
    })

    return () => {
      worker.value?.removeEventListener('message', onMessage)
      worker.value?.removeEventListener('error', (event: ErrorEvent) => {
        onError(event.error)
        loading.value = false
      })
    }
  }
  catch (err) {
    initializationErrored.value = true
    initializationError.value = err instanceof Error ? err.message : String(err)

    console.error('Failed to initialize worker:', err)
    loading.value = false
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

async function handleStartCall(k: VoiceName | string): Promise<void> {
  voice.value = k as VoiceName
  worker.value?.postMessage({
    type: 'set_voice',
    voice: k,
  })
}

async function handleDial() {
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

function handleEndCall(): void {
  callStarted.value = false
  callStartTime.value = null
  playing.value = false
  isListening.value = false
  isSpeaking.value = false
}

function shadesOfColorsFromRangeByIndex(
  index: number,
  range: number,
  options?: {
    baseAmplify?: number
    factor?: number
    inverted?: boolean
    reversed?: boolean
  },
): string {
  const baseAmplify = options?.baseAmplify ?? 0.5
  const factor = options?.factor ?? 0.5
  const inverted = options?.inverted ?? false
  const reversed = options?.reversed ?? false

  let lightness = baseAmplify + (index / range) * factor
  if (reversed) {
    lightness = 1 - lightness
  }

  const adjustedLightness = inverted ? 1 - lightness : lightness
  const color = oklch({ mode: 'oklch', l: adjustedLightness, h: 220, c: 0.1 })
  return formatRgb(converter('rgb')(color))
}
</script>

<template>
  <div class="relative h-100dvh w-100dvw flex flex-col items-center justify-center">
    <div absolute left-4 top-4 opacity-50>
      Conversational WebGPU
    </div>
    <div h-full flex items-center justify-center>
      <Transition name="fade" mode="out-in">
        <div v-if="initializationErrored" class="absolute inset-0 flex items-center justify-center" text="red-500 dark:red-400">
          <div flex flex-col items-center justify-center gap-4>
            <div i-solar:danger-triangle-line-duotone text-2xl />
            <div>
              {{ initializationError }}
            </div>
          </div>
        </div>
        <div v-else-if="loading">
          <div flex flex-col items-center justify-center gap-4>
            <div i-svg-spinners:3-dots-bounce text-2xl />
            <div>
              Initiating modules required for the call...
            </div>
          </div>
        </div>
        <div v-else-if="callStarted" h-full flex flex-col items-center justify-between p-4>
          <div>
            <div class="mb-4 flex items-center gap-2">
              <div text="cyan-600 dark:cyan-400" text-lg>
                {{ voices[voice]?.name || voice }} {{ elapsedTime }}
              </div>
            </div>
          </div>
          <div flex flex-col items-center gap-4>
            <div class="relative aspect-square h-32 w-32 flex flex-shrink-0 items-center justify-center">
              <template v-if="callStarted">
                <div
                  v-for="id in ripples"
                  :key="id"
                  class="pointer-events-none absolute inset-0 border-2 rounded-full"
                  :class="[
                    errored ? 'border-red-200 dark:border-red-400' : 'border-cyan-200 dark:border-cyan-500',
                  ]"
                  style="animation: ripple 1.5s ease-out forwards"
                />
              </template>
              <!-- Pulsing loader while initializing -->
              <div
                class="absolute h-32 w-32 rounded-full" :class="[
                  error ? 'bg-red-200 dark:bg-red-400' : 'bg-cyan-200 dark:bg-cyan-800',
                  !modelsInitialized ? 'animate-ping opacity-75' : '',
                ]"
                style="animation-duration: 1.5s"
              />
              <!-- Main rings -->
              <div
                class="absolute h-32 w-32 rounded-full shadow-inner transition-transform duration-300 ease-out" :class="[
                  error ? 'bg-red-300 dark:bg-red-400' : 'bg-cyan-300 dark:bg-cyan-800',
                  !modelsInitialized ? 'opacity-0' : '',
                ]"
                :style="{ transform: `scale(${speakingScale})` }"
              />
              <div
                class="absolute h-32 w-32 rounded-full shadow-inner transition-transform duration-300 ease-out" :class="[
                  error ? 'bg-red-200 dark:bg-red-400' : 'bg-cyan-200 dark:bg-cyan-600',
                  !modelsInitialized ? 'opacity-0' : '',
                ]"
                :style="{ transform: `scale(${listeningScale})` }"
              />
              <!-- Center text: show error if present, else existing statuses -->
              <div
                class="absolute z-10 text-center text-sm" :class="[
                  error ? 'text-red-700' : 'text-gray-700 dark:text-white',
                ]"
              >
                <template v-if="error">
                  <div i-solar:danger-triangle-line-duotone text-2xl />
                </template>
                <template v-else>
                  <template v-if="!modelsInitialized">
                    <div>
                      Loading...
                    </div>
                  </template>
                  <template v-if="isListening">
                    <div>
                      Listening...
                    </div>
                  </template>
                  <template v-if="isSpeaking">
                    <div>
                      Speaking...
                    </div>
                  </template>
                </template>
              </div>
            </div>
            <div v-if="errored">
              {{ error }}
            </div>
          </div>
          <div
            bg="cyan-50 dark:cyan-950"
            w-fit flex rounded-xl px-1 py-1 text-sm outline-none
          >
            <button
              bg="hover:cyan-100 dark:hover:cyan-900"
              text="red-400 hover:red-300 active:red-400"
              flex items-center gap-2 rounded-lg px-4 py-2 outline-none
              transition="all duration-300 ease-in-out"
              @click="handleEndCall"
            >
              <div i-solar:end-call-rounded-bold />
              <div text="black dark:white">
                End Call
              </div>
            </button>
          </div>
        </div>
        <Carousel
          v-else
          class="embla outline-none"
          transition="all duration-500 ease-in-out"
          :class="[
            callStarted ? 'embla-edge-disabled px-16 h-80 w-140' : 'px-8 h-50 w-120',
          ]"
        >
          <CarouselContent class="h-full flex gap-4" :style="{ touchAction: 'pan-y pinch-zoom' }">
            <CarouselItem
              v-for="([k, v], index) in Object.entries(voices)"
              :key="index"
              :style="{
                backgroundColor: shadesOfColorsFromRangeByIndex(index, Object.values(voices).length, { baseAmplify: 0.85, factor: 0.4 }),
                color: shadesOfColorsFromRangeByIndex(index, Object.values(voices).length, { baseAmplify: 0.5, factor: 0.2 }),
              }"
              class="h-full w-full flex-[0_0_80%] cursor-pointer rounded-lg"
              :class="[
                callStarted && voice !== k ? 'opacity-0' : '',
              ]"
              transition="all duration-500 ease-in-out"
              @click="() => handleStartCall(k)"
            >
              <Transition name="fade" mode="out-in">
                <div v-if="!callStarted" class="h-full w-full flex items-center justify-center gap-4 overflow-hidden rounded-lg">
                  <div i-solar:phone-bold text-2xl />
                  <div text-2xl>
                    {{ v.name }}
                  </div>
                </div>
                <div v-else class="h-full w-full flex items-center justify-center gap-4 overflow-hidden rounded-lg">
                  <div i-svg-spinners:3-dots-bounce text-2xl />
                  <div text-lg>
                    Connecting to {{ v.name }}...
                  </div>
                </div>
              </Transition>
            </CarouselItem>
          </CarouselContent>
        </Carousel>
      </Transition>
    </div>
    <div mb-4 flex items-center gap-2 text-sm opacity-50>
      <div inline-flex items-center gap-2>
        Built with
        <div i-logos:hugging-face-icon />
        <a href="https://huggingface.co/docs/transformers.js/index" class="decoration-neutral-700 dark:decoration-neutral-200" decoration-underline decoration-dashed>Transformers.js</a>
      </div>
      <div>
        |
      </div>
      <div inline-flex items-center gap-2>
        <div i-simple-icons:github />
        <a href="https://github.com/proj-airi/webai-examples/tree/main/apps/conversational-webgpu" class="decoration-neutral-700 dark:decoration-neutral-200" decoration-underline decoration-dashed>GitHub</a>
      </div>
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

.embla {
  position: relative;
  overflow: hidden;
}

.embla::before,
.embla::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: 48px;
  z-index: 1;
  pointer-events: none;
}

.embla-edge-disabled.embla::before,
.embla-edge-disabled.embla::after {
  display: none;
}

.embla::before {
  left: -32px;
  background: linear-gradient(90deg, #ffffff 0%, #ffffff 66%, transparent 80%);
}

.embla::after {
  right: -32px;
  background: linear-gradient(270deg, #ffffff 0%, #ffffff 66%, transparent 80%);
}

.dark .embla::before {
  left: -32px;
  background: linear-gradient(90deg, #121212 0%, #121212 66%, transparent 80%);
}

.dark .embla::after {
  right: -32px;
  background: linear-gradient(270deg, #121212 0%, #121212 66%, transparent 80%);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.5s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.fade-enter-to,
.fade-leave-from {
  opacity: 1;
}

.fade-scale-enter-active,
.fade-scale-leave-active {
  transition: all 0.2s ease-in-out;
}

.fade-scale-enter-from,
.fade-scale-leave-to {
  opacity: 0;
  transform: scale(0.8);
}

.fade-scale-enter-to,
.fade-scale-leave-from {
  opacity: 1;
  transform: scale(1);
}
</style>
