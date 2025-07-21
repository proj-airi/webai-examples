import type { GenerateOptions, KokoroTTS } from 'kokoro-js'

export type Voices = KokoroTTS['voices']
export type Voice = Voices[keyof Voices]
export type VoiceName = keyof Voices | NonNullable<GenerateOptions['voice']>
