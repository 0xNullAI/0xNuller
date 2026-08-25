import { useCallback, useEffect, useRef, useState } from 'react';
import type { LlmImageInput } from '@dg-agent/core';
import { captureCameraFrame } from '../services/camera-frame.js';

export type CameraFacingMode = 'user' | 'environment';
export type CameraPreviewState = 'off' | 'starting' | 'on' | 'error';

interface AndroidCameraBridge {
  hasCameraPermission(): boolean;
  requestCameraPermission(): void;
}

export function stopCameraStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

export function cameraEnvironmentError(): string | null {
  if (window.isSecureContext === false) return '摄像头仅可在 HTTPS 或 localhost 中使用';
  if (!navigator.mediaDevices?.getUserMedia) return '当前浏览器不支持摄像头预览';
  return null;
}

export function useCameraPreview(enabled: boolean, facingMode: CameraFacingMode) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const requestIdRef = useRef(0);
  const [state, setState] = useState<CameraPreviewState>('off');
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    requestIdRef.current += 1;
    const stream = streamRef.current;
    streamRef.current = null;
    stopCameraStream(stream);
    if (videoRef.current) videoRef.current.srcObject = null;
    setState('off');
    setError(null);
  }, []);

  const start = useCallback(async () => {
    if (!enabled) {
      setError('当前模型未明确支持图片输入，请在 AI 设置中选择视觉模型');
      setState('error');
      return;
    }
    const environmentError = cameraEnvironmentError();
    if (environmentError) {
      setError(environmentError);
      setState('error');
      return;
    }

    const requestId = ++requestIdRef.current;
    setState('starting');
    setError(null);
    try {
      const android = (window as Window & { AndroidSystem?: AndroidCameraBridge }).AndroidSystem;
      if (android && !android.hasCameraPermission()) android.requestCameraPermission();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: facingMode } },
      });
      if (requestId !== requestIdRef.current) {
        stopCameraStream(stream);
        return;
      }
      if (document.visibilityState === 'hidden') {
        stopCameraStream(stream);
        throw new Error('页面已隐藏，摄像头保持关闭');
      }
      stopCameraStream(streamRef.current);
      streamRef.current = stream;
      for (const track of stream.getVideoTracks())
        track.addEventListener('ended', stop, { once: true });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setState('on');
    } catch (cause) {
      stopCameraStream(streamRef.current);
      streamRef.current = null;
      setError(cause instanceof Error ? cause.message : '无法开启摄像头');
      setState('error');
    }
  }, [enabled, facingMode, stop]);

  const capture = useCallback(async (): Promise<LlmImageInput | undefined> => {
    if (!streamRef.current || !videoRef.current) return undefined;
    return captureCameraFrame(videoRef.current);
  }, []);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    let permission: PermissionStatus | undefined;
    const handlePermissionChange = () => {
      if (permission?.state === 'denied') stop();
    };
    void navigator.permissions
      ?.query({ name: 'camera' as PermissionName })
      .then((status) => {
        permission = status;
        status.addEventListener('change', handlePermissionChange);
        handlePermissionChange();
      })
      .catch(() => undefined);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      permission?.removeEventListener('change', handlePermissionChange);
      stop();
    };
  }, [stop]);

  useEffect(() => {
    if (!enabled) stop();
  }, [enabled, stop]);

  useEffect(() => {
    stop();
  }, [facingMode, stop]);

  return { videoRef, state, error, start, stop, capture };
}
