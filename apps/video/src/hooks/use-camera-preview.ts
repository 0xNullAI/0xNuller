import { useCallback, useEffect, useRef, useState } from 'react';
import type { LlmImageInput } from '@dg-agent/core';
import { captureCameraFrame, type CameraFrameSettings } from '../services/camera-frame.js';
import { FramePreviewUrl } from '../services/frame-preview-url.js';
import {
  canOpenAppSettings,
  ensureAndroidMediaPermission,
  explainMediaFailure,
  MediaPermissionDeniedError,
} from '@0xnullai/native';

export type CameraFacingMode = 'user' | 'environment';
export type CameraPreviewState = 'off' | 'starting' | 'on' | 'error';

export function stopCameraStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

export function cameraEnvironmentError(): string | null {
  if (window.isSecureContext === false) return '摄像头仅可在 HTTPS 或 localhost 中使用';
  if (!navigator.mediaDevices?.getUserMedia) return '当前浏览器不支持摄像头预览';
  return null;
}

export function useCameraPreview(
  facingMode: CameraFacingMode,
  frameSettings: CameraFrameSettings,
  onStopped?: () => void,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const processedPreviewRef = useRef<HTMLImageElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const requestIdRef = useRef(0);
  const settingsRef = useRef(frameSettings);
  const previewUrlRef = useRef<FramePreviewUrl | null>(null);
  const onStoppedRef = useRef(onStopped);
  settingsRef.current = frameSettings;
  onStoppedRef.current = onStopped;
  const [state, setState] = useState<CameraPreviewState>('off');
  const [error, setError] = useState<string | null>(null);
  /** The error is a refused permission that only the App's system settings can undo. */
  const [needsAppSettings, setNeedsAppSettings] = useState(false);

  const stop = useCallback(() => {
    requestIdRef.current += 1;
    onStoppedRef.current?.();
    const stream = streamRef.current;
    streamRef.current = null;
    stopCameraStream(stream);
    if (videoRef.current) videoRef.current.srcObject = null;
    previewUrlRef.current?.clear(processedPreviewRef.current);
    setState('off');
    setError(null);
    setNeedsAppSettings(false);
  }, []);

  const start = useCallback(async () => {
    const environmentError = cameraEnvironmentError();
    if (environmentError) {
      setError(environmentError);
      setNeedsAppSettings(false);
      setState('error');
      return;
    }

    const requestId = ++requestIdRef.current;
    setState('starting');
    setError(null);
    setNeedsAppSettings(false);
    let stream: MediaStream | null = null;
    try {
      // Android asks first and fails at once on a denial instead of waiting for a grant.
      const permitted = await ensureAndroidMediaPermission('camera', {
        isCurrent: () => requestId === requestIdRef.current,
      });
      if (!permitted) return;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          aspectRatio: { ideal: 16 / 9 },
        },
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
      if (requestId !== requestIdRef.current || streamRef.current !== stream) {
        stopCameraStream(stream);
        return;
      }
      setState('on');
    } catch (cause) {
      stopCameraStream(stream);
      if (requestId !== requestIdRef.current) return;
      if (streamRef.current === stream) streamRef.current = null;
      if (videoRef.current?.srcObject === stream) videoRef.current.srcObject = null;
      onStoppedRef.current?.();
      const explained = explainMediaFailure('camera', cause);
      setError(explained instanceof Error ? explained.message : '无法开启摄像头');
      setNeedsAppSettings(explained instanceof MediaPermissionDeniedError && canOpenAppSettings());
      setState('error');
    }
  }, [facingMode, stop]);

  const capture = useCallback(async (): Promise<LlmImageInput | undefined> => {
    if (!streamRef.current || !videoRef.current) return undefined;
    const requestId = requestIdRef.current;
    const frame = await captureCameraFrame(videoRef.current, settingsRef.current);
    if (requestId !== requestIdRef.current || !streamRef.current) return undefined;
    const preview = (previewUrlRef.current ??= new FramePreviewUrl());
    preview.show(frame.previewBlob, processedPreviewRef.current);
    return frame.image;
  }, []);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    let permission: PermissionStatus | undefined;
    let disposed = false;
    const handlePermissionChange = () => {
      if (permission?.state === 'denied') stop();
    };
    void navigator.permissions
      ?.query({ name: 'camera' as PermissionName })
      .then((status) => {
        if (disposed) return;
        permission = status;
        status.addEventListener('change', handlePermissionChange);
        handlePermissionChange();
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', handleVisibility);
      permission?.removeEventListener('change', handlePermissionChange);
      stop();
    };
  }, [stop]);

  useEffect(() => {
    stop();
  }, [facingMode, stop]);

  return {
    videoRef,
    processedPreviewRef,
    state,
    error,
    needsAppSettings,
    start,
    stop,
    capture,
  };
}
