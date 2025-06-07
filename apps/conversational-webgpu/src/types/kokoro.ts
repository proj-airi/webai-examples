import type { GenerateOptions, KokoroTTS } from 'kokoro-js'

export type Voices = Record<keyof KokoroTTS['voices'], KokoroTTS['voices'][keyof KokoroTTS['voices']]>
export type VoiceName = keyof Voices | NonNullable<GenerateOptions['voice']>
export type Voice = Voices[keyof Voices] & {
  name: VoiceName | string
}
