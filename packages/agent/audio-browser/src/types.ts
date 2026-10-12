export interface BrowserSpeechCapabilities {
  recognitionSupported: boolean;
  synthesisSupported: boolean;
}

export interface SpeechRecognitionRequest {
  onPartialTranscript?: (text: string) => void;
  manualStop?: boolean;
}

export interface SpeechRecognitionController {
  transcribeOnce(request?: SpeechRecognitionRequest): Promise<string>;
  stop(): void;
  abort(): void;
}

export interface SpeechSynthesizer {
  speak(text: string): Promise<void>;
  createStreamingSession(): SpeechSynthesisSession;
  stop(): void;
}

export interface SpeechSynthesisSession {
  pushAccumulatedText(accumulatedText: string): void;
  finish(finalText?: string): Promise<void>;
  abort(): void;
}

export interface BrowserSpeechRecognitionOptions {
  lang?: string;
}

export interface BrowserSpeechSynthesisOptions {
  lang?: string;
  browserVoiceUri?: string;
}

export interface BrowserSpeechSynthesisVoiceOption {
  voiceURI: string;
  name: string;
  lang: string;
  default: boolean;
  localService: boolean;
}

export const SPEECH_ABORTED_ERROR_MESSAGE = '语音采集已停止';
export const SPEECH_SYNTHESIS_ABORTED_ERROR_MESSAGE = '语音合成播放已停止';
