import { useEffect, useRef } from 'react';

/** Local preview only. The blob is never uploaded until the feature confirms sending. */
export function RecordedVoicePreview({ blob }: { blob: Blob }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(blob);
    if (audioRef.current) audioRef.current.src = objectUrl;
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);
  return <audio ref={audioRef} controls preload="metadata" aria-label="待发送语音预览" />;
}
