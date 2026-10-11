import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DeviceState, SensorState, SessionSnapshot } from '@dg-agent/core';
import type { OpossumState } from '@dg-kit/protocol';
import { savedPromptKind, type SavedScene } from '@0xnullai/scenes';
import { AssistantAvatar } from './AssistantAvatar.js';
import type { MarketItem } from '@0xnullai/market-client';
import {
  adaptPrivateAiTimeline,
  type TimelineItem as ConversationTimelineItem,
} from '@0xnullai/conversation';
import {
  listMediaJobs,
  currentAuthUserId,
  PrivateConversationAttachmentChannel,
  PrivateConversationChannel,
  type PrivateConversationAttachment,
  type MediaJob,
} from '@0xnullai/auth';
import {
  ArrowUp,
  AudioLines,
  Bluetooth,
  ChevronDown,
  Check,
  Gauge,
  Mic,
  CircleStop,
  Image as ImageIcon,
  Plus,
  Phone,
  Video,
  PanelLeft,
  PawPrint,
  Settings,
  Store,
  Vibrate,
  Zap,
} from 'lucide-react';
import {
  ConversationTimeline,
  ConversationComposer,
  ConversationEmpty,
  ConversationMessageRow,
  conversationBubbleClass,
  ChannelStrengthBar,
  DeviceStatusChip,
  Button,
  ConversationInput,
  RecordedVoicePreview,
  MarketImportDialog,
  Z_LOCAL_POPOVER,
  useInShell,
} from '@0xnullai/ui';
import { MarkdownText } from './MarkdownText.js';
import type { TraceFeedItem } from '../utils/trace-feed.js';
import { MediaJobPreview } from './CompanionMediaPanel.js';
import { VoiceTranscriptionControl } from './VoiceTranscriptionControl.js';

interface ChatPanelProps {
  accountId: string | null;
  activeSessionId: string | null;
  text: string;
  statusMessage: string | null;
  onTextChange: (value: string) => void;
  onAbortReply: () => void;
  onToggleVoiceMode: () => void;
  onSend: () => void;
  onAskImage: (attachment: PrivateConversationAttachment) => void;
  onAttachmentCommitted?: (conversationId: string) => void;
  onReplyToVoice?: (attachment: PrivateConversationAttachment) => void;
  onVoiceCall?: () => void;
  onCamera?: () => void;
  onGenerateMedia?: () => void;
  imageInputSupported: boolean;
  busy: boolean;
  speechRecognitionEnabled: boolean;
  voiceMode: boolean;
  voiceState: 'idle' | 'listening' | 'ready' | 'sending' | 'speaking';
  speechRecognitionSupported: boolean;
  session: SessionSnapshot | null;
  onLoadEarlier: (sessionId: string, before: number) => Promise<void>;
  observedSequence: number | null;
  onTranscriptTailVisibilityChange: (id: string, sequence: number, visible: boolean) => void;
  traceFeed: TraceFeedItem[];
  streamingAssistantText: string;
  /** Last failed reply for this conversation; shown here only, never saved. */
  failedReplyText?: string;
  deviceState: DeviceState;
  maxStrengthA: number;
  maxStrengthB: number;
  opossumState: OpossumState;
  maxOpossumIntensityA: number;
  maxOpossumIntensityB: number;
  pawPrintsState: SensorState;
  civetEdgingState: SensorState;
  onConnect: () => void;
  onDisconnectDevice: () => void;
  onDisconnectOpossum: () => void;
  onDisconnectPawPrints: () => void;
  onDisconnectCivetEdging: () => void;
  onEmergencyStop: () => void;
  onOpenSidebar: () => void;
  onOpenSettings: () => void;
  promptPresetId: string;
  sceneId: string;
  savedPresets: SavedScene[];
  onPresetChange: (id: string) => void;
  onSceneChange: (id: string | null) => void;
  onImportPreset: (item: MarketItem) => void;
  coyoteTargets: Array<{ id: string; label: string }>;
  activeCoyoteId: string | null;
  onCoyoteTargetChange: (id: string) => void;
}

const MESSAGE_BATCH_SIZE = 120;

// Bluetooth pairing hint: the browser's native chooser takes no injected copy, so this
// stays on screen while disconnected and doubles as the Bluetooth button's title, to
// help users get into pairing mode when the scan turns up no device.
const BLUETOOTH_PAIR_HINT = '搜不到设备？同时向下按住两侧滚轮 3–5 秒';

// The message row already caps the width. A second percentage cap here would resolve
// against a shrink-to-fit parent and wrap short messages one character early.
const BUBBLE_ASSISTANT = `${conversationBubbleClass(false)} max-w-full whitespace-normal`;
const BUBBLE_USER = `${conversationBubbleClass(true)} max-w-full whitespace-pre-wrap`;
const ICON_BTN =
  'h-9 w-9 rounded-[var(--radius-ctl)] text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]';
const SYSTEM_MSG =
  'max-w-[min(85%,480px)] rounded-[var(--radius-xs)] border-l-[3px] border-l-[var(--accent)] bg-[var(--accent-soft)] px-3.5 py-1.5 text-[13px] leading-[1.35] text-[var(--text-soft)]';

export function ChatPanel({
  accountId,
  activeSessionId,
  text,
  statusMessage,
  onTextChange,
  onAbortReply,
  onToggleVoiceMode,
  onSend,
  onAskImage,
  onAttachmentCommitted,
  onReplyToVoice,
  onVoiceCall,
  onCamera,
  onGenerateMedia,
  imageInputSupported,
  busy,
  speechRecognitionEnabled,
  voiceMode,
  voiceState: _voiceState,
  speechRecognitionSupported,
  session,
  onLoadEarlier,
  observedSequence,
  onTranscriptTailVisibilityChange,
  traceFeed,
  streamingAssistantText,
  failedReplyText = '',
  deviceState,
  maxStrengthA,
  maxStrengthB,
  opossumState,
  maxOpossumIntensityA,
  maxOpossumIntensityB,
  pawPrintsState,
  civetEdgingState,
  onConnect,
  onDisconnectDevice,
  onDisconnectOpossum,
  onDisconnectPawPrints,
  onDisconnectCivetEdging,
  onEmergencyStop,
  onOpenSidebar,
  onOpenSettings,
  promptPresetId,
  sceneId,
  savedPresets,
  onPresetChange,
  onSceneChange,
  onImportPreset,
  coyoteTargets,
  activeCoyoteId,
  onCoyoteTargetChange,
}: ChatPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const transcriptTailRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const olderScrollAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const hasText = text.trim().length > 0;
  const messages = useMemo(() => session?.messages ?? [], [session?.messages]);
  const sessionId = session?.id;
  const mediaOwner = accountId && sessionId ? `${accountId}\0${sessionId}` : null;
  const ownerRef = useRef(mediaOwner);
  useLayoutEffect(() => {
    ownerRef.current = mediaOwner;
  }, [mediaOwner]);
  const pendingUploadRef = useRef<{
    owner: string;
    channel: PrivateConversationAttachmentChannel;
  } | null>(null);
  const [mediaState, setMediaState] = useState<{ owner: string; items: MediaJob[] } | null>(null);
  const mediaJobs = useMemo(
    () => (mediaState?.owner === mediaOwner ? mediaState.items : []),
    [mediaState, mediaOwner],
  );
  const [attachmentRefresh, setAttachmentRefresh] = useState(0);
  const [attachmentState, setAttachmentState] = useState<{
    owner: string;
    items: PrivateConversationAttachment[];
  } | null>(null);
  const attachments = attachmentState?.owner === mediaOwner ? attachmentState.items : [];
  const [attachmentErrorState, setAttachmentErrorState] = useState<{
    owner: string;
    message: string;
  } | null>(null);
  const attachmentError =
    attachmentErrorState?.owner === mediaOwner ? attachmentErrorState.message : null;
  const [attachmentBusyOwner, setAttachmentBusyOwner] = useState<string | null>(null);
  const attachmentBusy = attachmentBusyOwner !== null && attachmentBusyOwner === mediaOwner;
  const [recordingOwner, setRecordingOwner] = useState<string | null>(null);
  const recording = recordingOwner !== null && recordingOwner === mediaOwner;
  const [pendingVoiceState, setPendingVoiceState] = useState<{
    owner: string;
    blob: Blob;
    caption: string;
  } | null>(null);
  const [pendingVoiceOwner, setPendingVoiceOwner] = useState(mediaOwner);
  if (pendingVoiceOwner !== mediaOwner) {
    setPendingVoiceOwner(mediaOwner);
    setPendingVoiceState(null);
  }
  const pendingVoice = pendingVoiceState?.owner === mediaOwner ? pendingVoiceState : null;
  const recorderRef = useRef<MediaRecorder | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const timelineItems = buildRenderableTimeline(
    {
      accountId: accountId ?? '',
      conversationId: sessionId ?? activeSessionId ?? '',
      agentId: promptPresetId,
      agentName: savedPresets.find((preset) => preset.id === promptPresetId)?.name ?? 'AI',
    },
    messages,
    traceFeed,
    mediaJobs,
    attachments,
  );
  const [visibleMessageCount, setVisibleMessageCount] = useState(MESSAGE_BATCH_SIZE);
  const [olderLoading, setOlderLoading] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const renderedMessages = timelineItems.slice(-visibleMessageCount);
  const voiceModeAvailable = speechRecognitionEnabled && speechRecognitionSupported;
  const [sceneDropdownOpen, setSceneDropdownOpen] = useState(false);
  const [marketImportOpen, setMarketImportOpen] = useState(false);
  const sceneDropdownRef = useRef<HTMLDivElement>(null);
  const [attachmentMenuState, setAttachmentMenuState] = useState<{ owner: string | null } | null>(
    null,
  );
  const attachmentMenuOpen = attachmentMenuState?.owner === mediaOwner;
  const attachmentMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!accountId || !sessionId || sessionId !== activeSessionId) return;
    const owner = `${accountId}\0${sessionId}`;
    const channel = new PrivateConversationAttachmentChannel(accountId, sessionId);
    let active = true;
    void (async () => {
      try {
        const items = await channel.list();
        if (active) setAttachmentState({ owner, items });
      } catch (error) {
        if (active && !(error instanceof Error && error.message === '会话不存在或已删除'))
          setAttachmentErrorState({
            owner,
            message: error instanceof Error ? error.message : '无法读取附件',
          });
      }
    })();
    return () => {
      active = false;
      channel.dispose();
    };
  }, [accountId, activeSessionId, sessionId, attachmentRefresh]);

  useEffect(() => {
    return () => {
      if (pendingUploadRef.current?.owner === mediaOwner) {
        pendingUploadRef.current.channel.dispose();
        pendingUploadRef.current = null;
      }
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        recorder.onstop = null;
        recorder.stop();
        recorder.stream.getTracks().forEach((track) => track.stop());
      }
      recorderRef.current = null;
    };
  }, [mediaOwner]);

  async function uploadAttachment(file: Blob, caption = ''): Promise<void> {
    if (!accountId || !sessionId || sessionId !== activeSessionId) return;
    const owner = `${accountId}\0${sessionId}`;
    const conversation = new PrivateConversationChannel({
      accountId,
      conversationId: sessionId,
      characterId: promptPresetId,
    });
    const channel = new PrivateConversationAttachmentChannel(accountId, sessionId);
    pendingUploadRef.current = { owner, channel };
    setAttachmentErrorState(null);
    setAttachmentBusyOwner(owner);
    try {
      await conversation.ensure();
      await channel.upload(file, caption);
      if (ownerRef.current === owner && currentAuthUserId() === accountId) {
        setAttachmentRefresh((value) => value + 1);
        setPendingVoiceState((current) =>
          current?.owner === owner && current.blob === file ? null : current,
        );
        onAttachmentCommitted?.(sessionId);
      }
    } catch (error) {
      if (ownerRef.current === owner && currentAuthUserId() === accountId)
        setAttachmentErrorState({
          owner,
          message: error instanceof Error ? error.message : '附件发送失败',
        });
    } finally {
      conversation.dispose();
      channel.dispose();
      if (pendingUploadRef.current?.channel === channel) pendingUploadRef.current = null;
      if (ownerRef.current === owner && currentAuthUserId() === accountId)
        setAttachmentBusyOwner(null);
    }
  }

  async function toggleVoiceRecording(): Promise<void> {
    const current = recorderRef.current;
    if (current?.state === 'recording') {
      current.stop();
      setRecordingOwner(null);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      if (mediaOwner)
        setAttachmentErrorState({ owner: mediaOwner, message: '当前浏览器不支持录制语音' });
      return;
    }
    const mime = ['audio/webm', 'audio/ogg', 'audio/mp4'].find((type) =>
      MediaRecorder.isTypeSupported(type),
    );
    if (!mime) {
      if (mediaOwner)
        setAttachmentErrorState({ owner: mediaOwner, message: '当前浏览器不支持此语音格式' });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const owner = accountId && sessionId ? `${accountId}\0${sessionId}` : null;
      if (!owner || ownerRef.current !== owner || currentAuthUserId() !== accountId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        recorderRef.current = null;
        if (ownerRef.current === owner && currentAuthUserId() === accountId && chunks.length)
          setPendingVoiceState({ owner, blob: new Blob(chunks, { type: mime }), caption: '' });
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecordingOwner(owner);
    } catch {
      if (mediaOwner) setAttachmentErrorState({ owner: mediaOwner, message: '无法使用麦克风' });
    }
  }

  useEffect(() => {
    if (!accountId || !sessionId || sessionId !== activeSessionId) return;
    const owner = `${accountId}\0${sessionId}`;
    let active = true;
    const refresh = async () => {
      try {
        const result = await listMediaJobs(sessionId);
        if (active) setMediaState({ owner, items: result.items });
      } catch {
        // Keep the last successfully loaded media; the separate media panel
        // still exposes service errors and can retry generation independently.
      }
    };
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ conversationId: string }>).detail?.conversationId === sessionId)
        void refresh();
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    window.addEventListener('0xnullai:media-jobs-changed', changed);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('0xnullai:media-jobs-changed', changed);
    };
  }, [accountId, activeSessionId, sessionId]);

  useEffect(() => {
    const tail = transcriptTailRef.current;
    const root = scrollContainerRef.current;
    if (
      !tail ||
      !root ||
      !sessionId ||
      sessionId !== activeSessionId ||
      !observedSequence ||
      typeof IntersectionObserver === 'undefined'
    )
      return;
    const id = sessionId;
    const sequence = observedSequence;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        onTranscriptTailVisibilityChange(
          id,
          sequence,
          Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.5),
        );
      },
      { root, threshold: 0.5 },
    );
    observer.observe(tail);
    return () => {
      observer.disconnect();
      onTranscriptTailVisibilityChange(id, sequence, false);
    };
  }, [activeSessionId, observedSequence, onTranscriptTailVisibilityChange, sessionId]);

  const characters = savedPresets.filter((preset) => savedPromptKind(preset) === 'character');
  const scenes = savedPresets.filter((preset) => savedPromptKind(preset) === 'scene');
  const activeCharacter = characters.find((preset) => preset.id === promptPresetId);
  const activeScene = scenes.find((preset) => preset.id === sceneId);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (sceneDropdownRef.current && !sceneDropdownRef.current.contains(e.target as Node)) {
        setSceneDropdownOpen(false);
      }
    }
    if (sceneDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [sceneDropdownOpen]);

  useEffect(() => {
    if (!attachmentMenuOpen) return;
    const closeOutside = (event: MouseEvent) => {
      if (!attachmentMenuRef.current?.contains(event.target as Node)) setAttachmentMenuState(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAttachmentMenuState(null);
    };
    document.addEventListener('mousedown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [attachmentMenuOpen]);

  useLayoutEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }

    const anchor = olderScrollAnchorRef.current;
    if (anchor) {
      scrollContainer.scrollTop = anchor.top + scrollContainer.scrollHeight - anchor.height;
      olderScrollAnchorRef.current = null;
      return;
    }
    if (!stickToBottomRef.current) return;

    scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }, [messages, mediaJobs, streamingAssistantText, failedReplyText, busy, statusMessage]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setVisibleMessageCount(MESSAGE_BATCH_SIZE);
    setOlderError(false);
  }, [accountId, activeSessionId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function triggerSend(): void {
    onSend();
  }

  function handlePrimaryAction(): void {
    if (busy) {
      onAbortReply();
      return;
    }
    if (hasText) {
      triggerSend();
      return;
    }
    if (voiceModeAvailable) {
      onToggleVoiceMode();
    }
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing &&
      e.nativeEvent.keyCode !== 229
    ) {
      e.preventDefault();
      if (!busy && hasText) triggerSend();
    }
  }

  function handleMessagesScroll(e: React.UIEvent<HTMLDivElement>): void {
    const element = e.currentTarget;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 48;
  }

  const inShell = useInShell();
  const showVoiceAsPrimary = !hasText && !busy;

  return (
    <div className="relative flex w-full flex-1 flex-col overflow-hidden">
      {/* ===== Narrow-screen top bar — only when standalone and no device is connected =====
          Not drawn inside the shell: the sidebar toggle, the module name and settings all
          come from the shell, so a second copy here means two hamburger buttons and two
          gears side by side on narrow screens. */}
      {!inShell &&
        !deviceState.connected &&
        !opossumState.connected &&
        !pawPrintsState.connected &&
        !civetEdgingState.connected && (
          <header className="flex shrink-0 items-center justify-between px-2 py-2 lg:hidden">
            <Button
              variant="ghost"
              size="icon"
              className={ICON_BTN}
              onClick={onOpenSidebar}
              aria-label="历史记录"
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-semibold text-[var(--text)]">Agent</span>
            <Button
              variant="ghost"
              size="icon"
              className={ICON_BTN}
              onClick={onOpenSettings}
              aria-label="设置"
            >
              <Settings className="h-4 w-4" />
            </Button>
          </header>
        )}

      {/* ===== Device status bar — shows whenever any of the four device kinds is connected ===== */}
      {!inShell &&
        (deviceState.connected ||
          opossumState.connected ||
          pawPrintsState.connected ||
          civetEdgingState.connected) && (
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[var(--surface-border)] bg-[var(--bg-elevated)] px-2 py-1.5 sm:gap-x-4 sm:px-3 sm:py-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 rounded-[var(--radius-xs)] text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)] lg:hidden"
              onClick={onOpenSidebar}
              aria-label="历史记录"
            >
              <PanelLeft className="h-4 w-4" />
            </Button>

            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5">
              {deviceState.connected && (
                <DeviceStatusChip
                  icon={<Zap className="h-3.5 w-3.5 text-[var(--success)]" />}
                  battery={deviceState.battery}
                  onClick={onDisconnectDevice}
                  title="断开郊狼"
                >
                  <div className="flex gap-3 sm:gap-4">
                    <ChannelStrengthBar
                      channel="A"
                      value={deviceState.strengthA}
                      max={maxStrengthA}
                    />
                    <ChannelStrengthBar
                      channel="B"
                      value={deviceState.strengthB}
                      max={maxStrengthB}
                    />
                  </div>
                </DeviceStatusChip>
              )}

              {opossumState.connected && (
                <DeviceStatusChip
                  icon={<Vibrate className="h-3.5 w-3.5 text-[var(--success)]" />}
                  battery={opossumState.battery}
                  onClick={onDisconnectOpossum}
                  title="断开负鼠"
                >
                  <div className="flex gap-3 sm:gap-4">
                    <ChannelStrengthBar
                      channel="A"
                      value={opossumState.intensityA}
                      max={maxOpossumIntensityA}
                    />
                    <ChannelStrengthBar
                      channel="B"
                      value={opossumState.intensityB}
                      max={maxOpossumIntensityB}
                    />
                  </div>
                </DeviceStatusChip>
              )}

              {pawPrintsState.connected && (
                <DeviceStatusChip
                  icon={<PawPrint className="h-3.5 w-3.5 text-[var(--success)]" />}
                  battery={pawPrintsState.battery}
                  onClick={onDisconnectPawPrints}
                  title="断开爪印"
                />
              )}

              {civetEdgingState.connected && (
                <DeviceStatusChip
                  icon={<Gauge className="h-3.5 w-3.5 text-[var(--success)]" />}
                  battery={civetEdgingState.battery}
                  onClick={onDisconnectCivetEdging}
                  title="断开灵猫"
                />
              )}
            </div>

            <Button
              variant="secondary"
              size="sm"
              className="h-7 shrink-0 rounded-[var(--radius-xs)] px-2 text-[12px] font-medium shadow-none sm:px-2.5"
              onClick={onConnect}
              aria-label="连接其他设备"
              title="连接其他设备"
            >
              <Bluetooth className="h-3.5 w-3.5" />
              <span className="hidden sm:inline text-xs">连接</span>
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-7 shrink-0 rounded-[var(--radius-xs)] px-2 text-[12px] font-medium shadow-none sm:px-2.5"
              onClick={onEmergencyStop}
              aria-label="紧急停止"
            >
              <CircleStop className="h-3.5 w-3.5" />
              <span className="hidden sm:inline text-xs">停止</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-[var(--radius-xs)] text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)] lg:hidden"
              onClick={onOpenSettings}
              aria-label="设置"
            >
              <Settings className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

      {coyoteTargets.length > 1 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2">
          <label htmlFor="agent-coyote-target" className="text-xs text-[var(--text-soft)]">
            AI 控制设备
          </label>
          <select
            id="agent-coyote-target"
            value={activeCoyoteId ?? coyoteTargets[0]?.id}
            onChange={(event) => onCoyoteTargetChange(event.target.value)}
            className="rounded-[var(--radius-xs)] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-2 py-1 text-xs text-[var(--text)]"
          >
            {coyoteTargets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {
        /* ===== Conversation timeline ===== */
        <>
          <ConversationTimeline ref={scrollContainerRef} onScroll={handleMessagesScroll}>
            {timelineItems.length === 0 && !busy && <ConversationEmpty />}
            {timelineItems.length > renderedMessages.length && (
              <div className="flex justify-center">
                <Button
                  variant="ghost"
                  className="rounded-full px-4 text-sm text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
                  onClick={() => setVisibleMessageCount((current) => current + MESSAGE_BATCH_SIZE)}
                >
                  加载更早消息（还有 {timelineItems.length - renderedMessages.length} 条）
                </Button>
              </div>
            )}
            {timelineItems.length <= renderedMessages.length &&
              session?.historyWindow?.nextBefore != null &&
              sessionId && (
                <div className="flex flex-col items-center gap-1">
                  <Button
                    variant="ghost"
                    className="rounded-full px-4 text-sm text-[var(--text-soft)]"
                    disabled={olderLoading}
                    onClick={() => {
                      const before = session.historyWindow?.nextBefore;
                      if (!before) return;
                      const scrollContainer = scrollContainerRef.current;
                      if (scrollContainer)
                        olderScrollAnchorRef.current = {
                          height: scrollContainer.scrollHeight,
                          top: scrollContainer.scrollTop,
                        };
                      stickToBottomRef.current = false;
                      setOlderLoading(true);
                      setOlderError(false);
                      void onLoadEarlier(sessionId, before)
                        .catch(() => setOlderError(true))
                        .finally(() => setOlderLoading(false));
                    }}
                  >
                    {olderLoading ? '加载中…' : '加载更早消息'}
                  </Button>
                  {olderError && (
                    <span className="text-xs text-[var(--danger)]">加载失败，请重试</span>
                  )}
                </div>
              )}

            {renderedMessages.map((message) => {
              if (message.kind === 'attachment') {
                return (
                  <div key={message.id} className="flex justify-end">
                    <div className={BUBBLE_USER}>
                      <PrivateAttachmentPreview
                        accountId={accountId!}
                        conversationId={sessionId!}
                        attachment={message.attachment}
                      />
                      {message.attachment.kind === 'voice' && message.attachment.caption && (
                        <p className="mt-2 text-sm">{message.attachment.caption}</p>
                      )}
                      <p className="mt-1 text-xs opacity-75">
                        {message.attachment.kind === 'image'
                          ? '图片已保存 · 仅在明确请求时交给 AI'
                          : message.attachment.caption
                            ? '用户附上的文字可供 AI 阅读；录音尚未自动转写'
                            : '语音已保存 · AI 尚未读取此附件'}
                      </p>
                      {message.attachment.kind === 'image' && imageInputSupported && (
                        <button
                          type="button"
                          className="mt-1 block text-xs underline disabled:opacity-50"
                          disabled={busy || attachmentBusy}
                          onClick={() => onAskImage(message.attachment)}
                        >
                          让 AI 看图
                        </button>
                      )}
                      {message.attachment.kind === 'voice' &&
                        message.attachment.caption &&
                        onReplyToVoice && (
                          <button
                            type="button"
                            className="mt-1 block text-xs underline disabled:opacity-50"
                            disabled={busy || attachmentBusy}
                            onClick={() => onReplyToVoice(message.attachment)}
                          >
                            请 AI 回应文字
                          </button>
                        )}
                      {message.attachment.kind === 'voice' && accountId && sessionId && (
                        <VoiceTranscriptionControl
                          accountId={accountId}
                          conversationId={sessionId}
                          attachmentId={message.attachment.id}
                          onUseText={(draft) =>
                            onTextChange(text.trim() ? `${text}\n${draft}` : draft)
                          }
                        />
                      )}
                    </div>
                  </div>
                );
              }
              if (message.kind === 'media') {
                const job = message.job;
                return (
                  <div key={message.id} className="flex justify-start">
                    <div className={BUBBLE_ASSISTANT}>
                      <p className="text-sm font-medium">
                        {job.kind === 'video'
                          ? '角色视频'
                          : job.kind === 'selfie'
                            ? '情境自拍'
                            : '生成图片'}
                        {' · '}
                        {job.state === 'succeeded'
                          ? '已完成'
                          : job.state === 'needs_review'
                            ? '账务待核对'
                            : job.state === 'failed'
                              ? '失败'
                              : job.state === 'submission_unknown'
                                ? '结果待核对'
                                : '处理中'}
                      </p>
                      <p className="mt-1 text-sm">{job.prompt}</p>
                      {job.state === 'succeeded' && <MediaJobPreview job={job} />}
                      {job.state !== 'succeeded' && job.lastError && (
                        <p className="mt-1 text-xs text-[var(--text-soft)]">{job.lastError}</p>
                      )}
                    </div>
                  </div>
                );
              }
              if (message.kind === 'trace-system') {
                return (
                  <div key={message.id} className="flex justify-center">
                    <div className={SYSTEM_MSG}>{message.content}</div>
                  </div>
                );
              }

              if (message.kind === 'camera_observation') {
                return (
                  <div key={message.id} className="flex justify-center">
                    <div className={SYSTEM_MSG}>
                      <span className="font-medium">摄像头观察</span>
                      <span className="ml-2">{message.content}</span>
                    </div>
                  </div>
                );
              }

              if (
                message.role === 'assistant' &&
                message.content.startsWith('Fake LLM 已完成工具执行：')
              ) {
                return (
                  <div key={message.id} className="flex justify-center">
                    <div className={SYSTEM_MSG}>旧版模型文字未核验工具执行，请查看设备状态。</div>
                  </div>
                );
              }

              if (message.role === 'system') {
                return (
                  <div key={message.id} className="flex justify-center">
                    <div className={SYSTEM_MSG}>{message.content}</div>
                  </div>
                );
              }

              const userMessage = message.role === 'user';
              return (
                <ConversationMessageRow
                  key={message.id}
                  own={userMessage}
                  avatar={
                    userMessage ? undefined : (
                      <AssistantAvatar
                        name={activeCharacter?.name ?? 'AI'}
                        icon={activeCharacter?.icon}
                        marketPortraitId={activeCharacter?.marketPortraitId}
                        relationshipId={
                          typeof session?.metadata?.relationshipId === 'string'
                            ? session.metadata.relationshipId
                            : null
                        }
                      />
                    )
                  }
                  contentClassName="max-w-[min(92%,560px)]"
                >
                  <div className={userMessage ? BUBBLE_USER : BUBBLE_ASSISTANT}>
                    {userMessage ? (
                      message.content
                    ) : (
                      <ScheduledMessageBody content={message.content} />
                    )}
                    {message.status === 'pending' && userMessage && (
                      <p className="mt-1 text-[10px] opacity-75">正在同步…</p>
                    )}
                  </div>
                </ConversationMessageRow>
              );
            })}

            {streamingAssistantText && (
              <div className="flex justify-start">
                <div className={BUBBLE_ASSISTANT}>
                  <MarkdownText content={streamingAssistantText} />
                </div>
              </div>
            )}

            {failedReplyText && !busy && (
              <div className="flex justify-start">
                <p
                  role="alert"
                  className="max-w-full rounded-[var(--radius-md)] border border-[var(--danger-border)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]"
                >
                  {failedReplyText}
                  <span className="mt-1 block text-xs text-[var(--text-faint)]">
                    这条提示不会保存到聊天记录。
                  </span>
                </p>
              </div>
            )}

            {busy && !streamingAssistantText && (
              <div className="flex justify-start">
                <div className="inline-flex items-center gap-1 rounded-[var(--radius-md)] rounded-bl-[var(--radius-2xs)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-4 py-3">
                  <span className="h-2 w-2 rounded-full bg-[var(--text-faint)] animate-pulse" />
                  <span className="h-2 w-2 rounded-full bg-[var(--text-faint)] animate-pulse [animation-delay:120ms]" />
                  <span className="h-2 w-2 rounded-full bg-[var(--text-faint)] animate-pulse [animation-delay:240ms]" />
                </div>
              </div>
            )}
            <div ref={transcriptTailRef} aria-hidden="true" className="h-px w-full shrink-0" />
          </ConversationTimeline>

          <ConversationComposer>
            {pendingVoice && (
              <div className="space-y-2 rounded-xl border border-[var(--surface-border)] bg-[var(--bg-soft)] p-3">
                <p className="text-sm">录音待发送</p>
                <RecordedVoicePreview blob={pendingVoice.blob} />
                <input
                  type="text"
                  maxLength={2000}
                  value={pendingVoice.caption}
                  onChange={(event) =>
                    setPendingVoiceState((current) =>
                      current?.owner === mediaOwner
                        ? { ...current, caption: event.target.value }
                        : current,
                    )
                  }
                  placeholder="填写语音文字，AI 才能理解内容（不会自动转写）"
                  aria-label="语音文字"
                  className="w-full rounded-lg border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm"
                />
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    disabled={attachmentBusy}
                    onClick={() => setPendingVoiceState(null)}
                  >
                    取消
                  </Button>
                  <Button
                    disabled={attachmentBusy}
                    onClick={() => void uploadAttachment(pendingVoice.blob, pendingVoice.caption)}
                  >
                    {pendingVoice.caption.trim() ? '发送语音和文字' : '仅发送语音'}
                  </Button>
                </div>
              </div>
            )}
            {attachmentError && (
              <p role="alert" className="px-2 text-xs text-[var(--danger)]">
                {attachmentError}
              </p>
            )}
            <div className="relative flex items-center gap-2" ref={sceneDropdownRef}>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-[var(--text-soft)] hover:bg-[var(--bg-soft)]"
                onClick={() => setSceneDropdownOpen((v) => !v)}
                aria-expanded={sceneDropdownOpen}
              >
                <span>{activeCharacter?.icon ?? '✦'}</span>
                <span className="max-w-36 truncate">
                  {activeCharacter?.name ?? 'AI'}
                  {activeScene ? ` · ${activeScene.name}` : ''}
                </span>
                <ChevronDown className="h-3 w-3" />
              </button>
              {sceneDropdownOpen && (
                <div
                  className={`absolute bottom-full left-0 ${Z_LOCAL_POPOVER} mb-1 max-h-72 w-52 overflow-y-auto rounded-lg border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-1 shadow-lg`}
                >
                  <div className="px-2 py-1 text-[11px] text-[var(--text-faint)]">角色</div>
                  {characters.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-[var(--bg-soft)]"
                      onClick={() => {
                        onPresetChange(preset.id);
                        setSceneDropdownOpen(false);
                      }}
                    >
                      <span>{preset.icon ?? '✦'}</span>
                      <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                      {preset.id === promptPresetId && <Check className="h-4 w-4" />}
                    </button>
                  ))}
                  <div className="border-t border-[var(--surface-border)] px-2 py-1 text-[11px] text-[var(--text-faint)]">
                    场景
                  </div>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-[var(--bg-soft)]"
                    onClick={() => {
                      onSceneChange(null);
                      setSceneDropdownOpen(false);
                    }}
                  >
                    <span className="min-w-0 flex-1">无场景</span>
                    {!sceneId && <Check className="h-4 w-4" />}
                  </button>
                  {scenes.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-[var(--bg-soft)]"
                      onClick={() => {
                        onSceneChange(preset.id);
                        setSceneDropdownOpen(false);
                      }}
                    >
                      <span>{preset.icon ?? '✦'}</span>
                      <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                      {preset.id === sceneId && <Check className="h-4 w-4" />}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 border-t border-[var(--surface-border)] px-2 py-2 text-left text-sm"
                    onClick={() => {
                      setSceneDropdownOpen(false);
                      setMarketImportOpen(true);
                    }}
                  >
                    <Store className="h-4 w-4" />从 Market 导入角色或场景
                  </button>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input
                ref={imageInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                aria-label="选择发送的图片"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (file) void uploadAttachment(file);
                }}
              />
              <div className="relative shrink-0" ref={attachmentMenuRef}>
                <Button
                  variant="ghost"
                  size="icon"
                  className={ICON_BTN}
                  disabled={!activeSessionId || !accountId || busy || recording || attachmentBusy}
                  onClick={() =>
                    setAttachmentMenuState(attachmentMenuOpen ? null : { owner: mediaOwner })
                  }
                  aria-label="添加聊天内容"
                  aria-expanded={attachmentMenuOpen}
                  aria-haspopup="menu"
                >
                  <Plus className="h-5 w-5" />
                </Button>
                {attachmentMenuOpen && (
                  <div
                    role="menu"
                    aria-label="聊天能力"
                    className={`absolute bottom-full left-0 ${Z_LOCAL_POPOVER} mb-2 max-h-[min(70dvh,380px)] w-48 overflow-y-auto rounded-xl border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-1 shadow-lg`}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      disabled={attachmentBusy || recording}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--bg-soft)] disabled:opacity-50"
                      onClick={() => {
                        setAttachmentMenuState(null);
                        imageInputRef.current?.click();
                      }}
                    >
                      <ImageIcon className="h-4 w-4" />
                      发送图片
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={attachmentBusy || recording}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--bg-soft)] disabled:opacity-50"
                      onClick={() => {
                        setAttachmentMenuState(null);
                        void toggleVoiceRecording();
                      }}
                    >
                      <Mic className="h-4 w-4" />
                      录制语音
                    </button>
                    {onVoiceCall && (
                      <button
                        type="button"
                        role="menuitem"
                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--bg-soft)]"
                        onClick={() => {
                          setAttachmentMenuState(null);
                          onVoiceCall();
                        }}
                      >
                        <Phone className="h-4 w-4" />
                        语音通话
                      </button>
                    )}
                    {onCamera && (
                      <button
                        type="button"
                        role="menuitem"
                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--bg-soft)]"
                        onClick={() => {
                          setAttachmentMenuState(null);
                          onCamera();
                        }}
                      >
                        <Video className="h-4 w-4" />
                        摄像头观察
                      </button>
                    )}
                    {onGenerateMedia && (
                      <button
                        type="button"
                        role="menuitem"
                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--bg-soft)]"
                        onClick={() => {
                          setAttachmentMenuState(null);
                          onGenerateMedia();
                        }}
                      >
                        <ImageIcon className="h-4 w-4" />
                        生成图片或视频
                      </button>
                    )}
                  </div>
                )}
              </div>
              {recording && (
                <Button
                  variant="destructive"
                  size="icon"
                  className={ICON_BTN}
                  onClick={() => void toggleVoiceRecording()}
                  aria-label="结束录音"
                  title="结束录音"
                >
                  <CircleStop className="h-4 w-4" />
                </Button>
              )}
              <ConversationInput
                ref={inputRef}
                type="text"
                value={text}
                disabled={busy || voiceMode}
                onChange={(e) => onTextChange(e.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder={voiceMode ? '语音识别中…' : '输入消息…'}
              />
              {!inShell && !deviceState.connected && (
                <Button
                  variant="secondary"
                  size="icon"
                  className="h-10 w-10 shrink-0 rounded-[var(--radius-ctl)]"
                  onClick={onConnect}
                  aria-label="连接设备"
                  title={BLUETOOTH_PAIR_HINT}
                >
                  <Bluetooth className="h-4 w-4" />
                </Button>
              )}
              {voiceMode ? (
                <Button
                  variant="destructive"
                  size="icon"
                  className="h-10 w-10 shrink-0 rounded-[var(--radius-ctl)]"
                  onClick={onToggleVoiceMode}
                  aria-label="结束识别"
                >
                  <Mic className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  variant={
                    busy
                      ? 'destructive'
                      : showVoiceAsPrimary && voiceModeAvailable
                        ? 'secondary'
                        : hasText
                          ? 'default'
                          : 'secondary'
                  }
                  size="icon"
                  className="h-10 w-10 shrink-0 rounded-[var(--radius-ctl)]"
                  disabled={!activeSessionId || (!hasText && !busy && !voiceModeAvailable)}
                  onClick={handlePrimaryAction}
                  aria-label={
                    busy ? '停止回复' : hasText ? '发送' : voiceModeAvailable ? '语音识别' : '发送'
                  }
                >
                  {busy ? (
                    <CircleStop className="h-4 w-4" />
                  ) : showVoiceAsPrimary && voiceModeAvailable ? (
                    <AudioLines className="h-4 w-4" />
                  ) : (
                    <ArrowUp className="h-4 w-4" />
                  )}
                </Button>
              )}
            </div>
          </ConversationComposer>
          {!inShell && !deviceState.connected && (
            <p className="mx-auto w-full max-w-[800px] shrink-0 px-3 pt-1.5 text-center text-[11px] leading-relaxed text-[var(--text-faint)] sm:px-6">
              {BLUETOOTH_PAIR_HINT}
            </p>
          )}
        </>
      }

      <MarketImportDialog
        open={marketImportOpen}
        onOpenChange={setMarketImportOpen}
        type="scenario"
        onImport={(item) => {
          onImportPreset(item);
          setMarketImportOpen(false);
        }}
      />
    </div>
  );
}

type TimelineItem =
  | (Omit<SessionSnapshot['messages'][number], 'kind'> & {
      kind: 'message' | 'camera_observation';
      status: ConversationTimelineItem['status'];
    })
  | { kind: 'trace-system'; id: string; content: string; createdAt: number }
  | { kind: 'media'; id: string; job: MediaJob; createdAt: number }
  | {
      kind: 'attachment';
      id: string;
      attachment: PrivateConversationAttachment;
      createdAt: number;
    };

function buildRenderableTimeline(
  identity: { accountId: string; conversationId: string; agentId: string; agentName: string },
  messages: SessionSnapshot['messages'],
  traceFeed: TraceFeedItem[],
  mediaJobs: MediaJob[],
  attachments: PrivateConversationAttachment[],
): TimelineItem[] {
  const projection = adaptPrivateAiTimeline({ ...identity, messages, attachments });
  const projectedById = new Map(projection.map((item) => [item.itemId, item]));
  const visibleMessages: TimelineItem[] = messages
    .filter((message) => !attachments.some((item) => item.messageId === message.id))
    .filter(shouldRenderTimelineMessage)
    .map((message) => ({
      ...message,
      kind:
        projectedById.get(message.id)?.kind === 'camera_observation'
          ? ('camera_observation' as const)
          : ('message' as const),
      status: projectedById.get(message.id)?.status ?? 'pending',
    }));
  const extras: TimelineItem[] = [
    ...traceFeed.map((item) => ({
      kind: 'trace-system' as const,
      id: `trace-feed:${item.id}`,
      content: item.text,
      createdAt: item.createdAt,
    })),
    ...mediaJobs.map((job) => ({
      kind: 'media' as const,
      id: `media:${job.id}`,
      job,
      createdAt: job.createdAt,
    })),
    ...attachments.map((attachment) => ({
      kind: 'attachment' as const,
      id: `attachment:${attachment.id}`,
      attachment,
      createdAt: attachment.createdAt,
    })),
  ];
  // Server message array order is authoritative even if an old client clock was wrong.
  // Auxiliary records have no conversation sequence yet; insert them at a stable boundary.
  const buckets: TimelineItem[][] = Array.from({ length: visibleMessages.length + 1 }, () => []);
  for (const extra of extras.sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  )) {
    const messageId = extra.kind === 'attachment' ? extra.attachment.messageId : null;
    let after = messageId ? visibleMessages.findIndex((message) => message.id === messageId) : -1;
    if (after < 0)
      for (const [index, message] of visibleMessages.entries())
        if (message.createdAt <= extra.createdAt) after = index;
    buckets[after + 1]!.push(extra);
  }
  return visibleMessages
    .flatMap((message, index) => [...buckets[index]!, message])
    .concat(buckets.at(-1)!);
}

function shouldRenderTimelineMessage(message: SessionSnapshot['messages'][number]): boolean {
  if (message.role === 'user' && message.content.trim().length === 0) return false;
  if (message.role !== 'assistant') {
    return true;
  }

  return message.content.trim().length > 0;
}

function PrivateAttachmentPreview({
  accountId,
  conversationId,
  attachment,
}: {
  accountId: string;
  conversationId: string;
  attachment: PrivateConversationAttachment;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '120px' },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const channel = new PrivateConversationAttachmentChannel(accountId, conversationId);
    let active = true;
    let objectUrl: string | null = null;
    void channel
      .read(attachment)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      channel.dispose();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [accountId, attachment, conversationId, visible]);
  return (
    <div ref={hostRef} className="min-h-12 min-w-32">
      {!url ? (
        <span className="text-xs">{attachment.kind === 'image' ? '加载图片…' : '加载语音…'}</span>
      ) : attachment.kind === 'image' ? (
        <img src={url} alt="已发送图片" className="max-h-72 max-w-full rounded-lg object-contain" />
      ) : (
        <audio src={url} controls preload="none" aria-label="已发送语音" />
      )}
    </div>
  );
}

/**
 * Server-delivered companion messages start with a one-line kind label. Show it as a tag
 * above the text rather than as the first words of the reply.
 */
const SCHEDULED_LABELS = { AI主动消息: '主动消息', 定时消息: '定时消息' } as const;
export function ScheduledMessageBody({ content }: { content: string }) {
  const newline = content.indexOf('\n');
  const first = newline > 0 ? content.slice(0, newline) : '';
  const label = SCHEDULED_LABELS[first as keyof typeof SCHEDULED_LABELS];
  if (!label) return <MarkdownText content={content} />;
  return (
    <>
      <span className="mb-1 inline-block rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] text-[var(--accent)]">
        {label}
      </span>
      <MarkdownText content={content.slice(newline + 1)} />
    </>
  );
}
