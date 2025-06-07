import type { VoiceName, Voices } from '../types/kokoro'
import type { WorkerMessageEvent } from '../types/worker'

import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

import { INPUT_SAMPLE_RATE } from '../constants'
import WORKLET_URL from '../workers/audio/play-worklet?worker&url'
import VAD_WORKLET_URL from '../workers/audio/vad-processor?worker&url'
import WORKER_URL from '../workers/audio/worker?url'

export const useAudioStore = defineStore('audio', () => {
  // Audio state
  const audioWorker = ref<Worker | null>(null)
  const voice = ref<VoiceName>('af_heart')
  const voices = ref<Voices>({} as Voices)
  const audioReady = ref<boolean>(false)
  const audioError = ref<string | null>(null)
  const playing = ref<boolean>(false)
  const isListening = ref<boolean>(false)
  const isSpeaking = ref<boolean>(false)
  const micStreamRef = ref<MediaStream | null>(null)
  const audioNode = ref<AudioWorkletNode | null>(null)
  const listeningScale = ref<number>(1)
  const speakingScale = ref<number>(1)

  // Callbacks for external integration
  const onListeningStart = ref<(() => void) | null>(null)
  const onListeningEnd = ref<(() => void) | null>(null)

  // Audio worker setup
  function setupAudioWorker() {
    audioWorker.value = new Worker(WORKER_URL, { type: 'module' })

    const onError = (err: Error | unknown): void => {
      audioError.value = err instanceof Error ? err.message : String(err)
    }

    const onMessage = ({ data }: { data: WorkerMessageEvent }): void => {
      switch (data.type) {
        case 'error':
          return onError(data.data.error)
        case 'status':
          if (data.data.status === 'recording_start') {
            isListening.value = true
            isSpeaking.value = false
            onListeningStart.value?.()
          }
          else if (data.data.status === 'recording_end') {
            isListening.value = false
            onListeningEnd.value?.()
          }
          else if (data.data.status === 'ready') {
            voices.value = data.data.voices || {} as Voices
            audioReady.value = true
          }
          break
        case 'output':
          if (!playing.value && audioNode.value && data.data.result) {
            audioNode.value.port.postMessage(data.data.result.audio)
            playing.value = true
            isSpeaking.value = true
            isListening.value = false
          }
          break
      }
    }

    audioWorker.value.addEventListener('message', onMessage)
    audioWorker.value.addEventListener('error', (event: ErrorEvent) => onError(event.error))
  }

  // Audio call setup
  async function setupAudioCall() {
    if (!audioReady.value)
      return

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

      const inputAudioContext = new AudioContext({
        sampleRate: INPUT_SAMPLE_RATE,
      })

      const analyser = inputAudioContext.createAnalyser()
      analyser.fftSize = 256
      const source = inputAudioContext.createMediaStreamSource(stream)
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

      await inputAudioContext.audioWorklet.addModule(VAD_WORKLET_URL)
      const worklet = new AudioWorkletNode(inputAudioContext, 'vad-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete',
      })

      source.connect(worklet)
      worklet.port.onmessage = (event: MessageEvent) => {
        const { buffer } = event.data
        audioWorker.value?.postMessage({ type: 'audio', buffer })
      }

      const outputAudioContext = new AudioContext({ sampleRate: 24000 })
      outputAudioContext.resume()

      await outputAudioContext.audioWorklet.addModule(new URL(WORKLET_URL, import.meta.url))

      audioNode.value = new AudioWorkletNode(
        outputAudioContext,
        'buffered-audio-worklet-processor',
      )

      audioNode.value.port.onmessage = (event: MessageEvent) => {
        if (event.data.type === 'playback_ended') {
          playing.value = false
          isSpeaking.value = false
          audioWorker.value?.postMessage({ type: 'playback_ended' })
        }
      }

      const outputAnalyser = outputAudioContext.createAnalyser()
      outputAnalyser.fftSize = 256

      audioNode.value.connect(outputAnalyser)
      outputAnalyser.connect(outputAudioContext.destination)

      const outputDataArray = new Uint8Array(outputAnalyser.frequencyBinCount)

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
    }
    catch (err) {
      if (err instanceof Error) {
        audioError.value = err.message
        console.error(err)
      }
    }
  }

  // Send text to TTS
  function synthesizeText(text: string) {
    if (audioWorker.value) {
      audioWorker.value.postMessage({
        type: 'synthesize_text',
        text,
      })
    }
  }

  // Start audio call
  function startCall() {
    audioWorker.value?.postMessage({ type: 'start_call' })
  }

  // End audio call
  function endCall() {
    audioWorker.value?.postMessage({ type: 'end_call' })
    micStreamRef.value?.getTracks().forEach(track => track.stop())
    micStreamRef.value = null
  }

  // Cleanup
  function cleanup() {
    audioWorker.value?.terminate()
    endCall()
  }

  // Watch for voice changes
  watch(voice, () => {
    audioWorker.value?.postMessage({
      type: 'set_voice',
      voice: voice.value,
    })
  })

  return {
    // State
    voice,
    voices,
    audioReady,
    audioError,
    playing,
    isListening,
    isSpeaking,
    listeningScale,
    speakingScale,

    // Callbacks
    onListeningStart,
    onListeningEnd,

    // Methods
    setupAudioWorker,
    setupAudioCall,
    synthesizeText,
    startCall,
    endCall,
    cleanup,
  }
})
