import { CharacterStudioPreview } from './CharacterStudioPreview';
import { CharacterStudioDrawing } from './CharacterStudioDrawing';
import { CharacterStudioDraftSaver } from './CharacterStudioDraft';
import { currentAuthUserId, subscribeAuthChanges } from '@0xnullai/auth';
import {
  emptyCharacterCard,
  parseCharacterCard,
  type CharacterCard,
} from '@0xnullai/scenes/character-card';
import { type ExternalCardArchive } from '@0xnullai/scenes/character-draft';
import { CharacterCardFields } from '@0xnullai/scenes/character-editor';
import { Button, registerNavigationGuard } from '@0xnullai/ui';
import { useEffect, useLayoutEffect, useState, useMemo, useRef } from 'react';
import type {
  CharacterDraft,
  CharacterRevisionSummary,
  MarketItem,
  ScenarioContent,
  UploadPayload,
  PromptKind,
} from '../../shared/schema';
import { CharacterDraftSchema, MAX_SCENARIO_PROMPT_LENGTH, promptKind } from '../../shared/schema';
import {
  deleteCharacterDraft,
  deleteCharacterPortrait,
  deleteCharacterContainer,
  fetchCharacterVersion,
  fetchCharacterVersions,
  fetchCharacterDraft,
  fetchCharacterPortrait,
  fetchCharacterContainer,
  listCharacterContainers,
  saveCharacterDraft,
  uploadCharacterPortrait,
  uploadCharacterContainer,
  updateItem,
  uploadItem,
} from '../api';
import type { PrivateCharacterContainer } from '../api';
import { importExternalCardFile } from '../external-card-file';

interface Props {
  item?: MarketItem;
  initialKind?: PromptKind;
  onClose: () => void;
  onSaved: (id: string) => void;
}

function hasLocalAssetReferences(archive: ExternalCardArchive | undefined): boolean {
  const assets = (archive?.raw.data as Record<string, unknown> | undefined)?.assets;
  return (
    Array.isArray(assets) &&
    assets.some((asset) => {
      const uri = asset && typeof asset === 'object' ? (asset as { uri?: unknown }).uri : undefined;
      return (
        typeof uri === 'string' && (uri.startsWith('embeded://') || uri.startsWith('__asset:'))
      );
    })
  );
}

/** A page-sized editor for a public Prompt card; private companion settings live in Chat. */
export function CharacterStudio({ item, initialKind, onClose, onSaved }: Props) {
  const source = item?.type === 'scenario' ? (item.content as ScenarioContent) : null;
  const sourceKind = source ? promptKind(source) : null;
  const [kind, setKind] = useState<PromptKind>(
    source ? promptKind(source) : (initialKind ?? 'character'),
  );
  const [name, setName] = useState(item?.name ?? '');
  const [prompt, setPrompt] = useState(source?.prompt ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [icon, setIcon] = useState(item?.icon ?? '🎭');
  const [tagsText, setTagsText] = useState(item?.tags.join('、') ?? '');
  const [card, setCard] = useState<CharacterCard>(
    parseCharacterCard(source?.characterCard) ?? emptyCharacterCard(),
  );
  const [sourceArchive, setSourceArchive] = useState<ExternalCardArchive | undefined>(
    source?.sourceArchive ?? undefined,
  );
  const [originalFile, setOriginalFile] = useState<File | null>(null);
  const [sourceFileId, setSourceFileId] = useState<string | undefined>(undefined);
  const [sourceFileName, setSourceFileName] = useState<string | undefined>(undefined);
  const [privateContainers, setPrivateContainers] = useState<PrivateCharacterContainer[] | null>(
    null,
  );
  const [privateContainersError, setPrivateContainersError] = useState('');
  const [drawingOpen, setDrawingOpen] = useState(false);
  const [drawingDirty, setDrawingDirty] = useState(false);
  const [portraitId, setPortraitId] = useState(source?.portraitId ?? undefined);
  const [portraitPreview, setPortraitPreview] = useState<{ id: string; url: string } | null>(null);
  const [publishSource, setPublishSource] = useState(
    Boolean(source?.sourceArchive && !hasLocalAssetReferences(source.sourceArchive)),
  );
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const unresolvedAssets = hasLocalAssetReferences(sourceArchive);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draftReady, setDraftReady] = useState(false);
  const [autosaveState, setAutosaveState] = useState(
    currentAuthUserId() ? '正在读取在线草稿…' : '登录后可自动保存在线草稿',
  );
  const [savedFingerprint, setSavedFingerprint] = useState('');
  const [accountChanged, setAccountChanged] = useState(false);
  const [reloadDraft, setReloadDraft] = useState(0);
  const published = useRef(false);
  const importDetails = useRef<HTMLDetailsElement>(null);
  const [serverDraft, setServerDraft] = useState<CharacterDraft | null>(null);
  const [draftNotice, setDraftNotice] = useState('');
  const [versions, setVersions] = useState<CharacterRevisionSummary[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [historyBusy, setHistoryBusy] = useState(false);
  const draftKey = item?.id ?? (kind === 'character' ? 'new' : 'new-scene');
  const [owner] = useState(currentAuthUserId);
  useEffect(() => {
    if (sourceArchive || originalFile || sourceFileId) {
      if (importDetails.current) importDetails.current.open = true;
    }
  }, [sourceArchive, originalFile, sourceFileId]);
  const saver = useMemo(
    () =>
      new CharacterStudioDraftSaver((draft, revision) => {
        if (!owner || currentAuthUserId() !== owner)
          throw new Error('账户已切换，请重新打开编辑器');
        return saveCharacterDraft(draftKey, owner, draft, revision);
      }),
    [draftKey, owner],
  );
  useEffect(() => {
    const detach = saver.attach();
    const unsubscribe = subscribeAuthChanges(() => {
      if (currentAuthUserId() !== owner) {
        saver.dispose();
        setAccountChanged(true);
      }
    });
    return () => {
      unsubscribe();
      detach();
    };
  }, [saver, owner]);
  const draftValue = useMemo(
    () =>
      CharacterDraftSchema.safeParse({
        kind,
        name,
        prompt,
        description,
        icon,
        tags: tagsText
          .split(/[,，、\s]+/)
          .map((tag) => tag.trim())
          .filter(Boolean),
        card,
        sourceArchive,
        sourceFileId,
        sourceFileName,
        portraitId,
      }),
    [
      name,
      kind,
      prompt,
      description,
      icon,
      tagsText,
      card,
      sourceArchive,
      sourceFileId,
      sourceFileName,
      portraitId,
    ],
  );
  const fingerprint = JSON.stringify(
    draftValue.success
      ? draftValue.data
      : {
          name,
          kind,
          prompt,
          description,
          icon,
          tagsText,
          card,
          sourceArchive,
          sourceFileId,
          sourceFileName,
          portraitId,
        },
  );
  const [initialFingerprint] = useState(fingerprint);
  const draftDirty = fingerprint !== (savedFingerprint || initialFingerprint);
  const dirty = draftDirty || drawingDirty || (originalFile !== null && !sourceFileId);
  useLayoutEffect(
    () =>
      registerNavigationGuard((_destination, sourceLocation) => {
        if (!dirty || accountChanged || published.current || currentAuthUserId() !== owner)
          return null;
        // The shell keeps hidden modules mounted. Only protect this editor while Market is visible.
        if (sourceLocation.pathname !== '/market') return null;
        return '公开内容还有未保存到服务器的修改。确定离开并放弃这些修改？';
      }),
    [dirty, accountChanged, owner],
  );

  useEffect(() => {
    if (!dirty || accountChanged) return;
    const prevent = (event: BeforeUnloadEvent) => {
      if (!published.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, accountChanged]);
  useEffect(() => {
    if (
      !draftDirty ||
      !draftReady ||
      serverDraft ||
      busy ||
      accountChanged ||
      !owner ||
      (originalFile !== null && !sourceFileId) ||
      !draftValue.success
    )
      return;
    const timer = window.setTimeout(() => {
      setAutosaveState('正在自动保存…');
      void saver
        .save(draftValue.data, true)
        .then((revision) => {
          if (revision === null) {
            setAutosaveState('自动保存已暂停，请手动重试');
            return;
          }
          setSavedFingerprint(JSON.stringify(draftValue.data));
          setAutosaveState('已自动保存到账号');
        })
        .catch((reason: unknown) => {
          if (currentAuthUserId() === owner) {
            setAutosaveState('自动保存已暂停，请重试或重新读取草稿');
            setError(reason instanceof Error ? reason.message : '自动保存失败');
          }
        });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [
    draftDirty,
    draftReady,
    serverDraft,
    busy,
    accountChanged,
    owner,
    originalFile,
    sourceFileId,
    draftValue,
    saver,
  ]);
  const closeEditor = () => {
    if (dirty && !window.confirm('还有未保存到服务器的修改。确定离开并放弃这些修改？')) return;
    saver.pause();
    onClose();
  };

  useEffect(() => {
    if (!portraitId) return;
    let live = true;
    let url: string | undefined;
    void fetchCharacterPortrait(portraitId)
      .then((blob) => {
        if (!live) return;
        url = URL.createObjectURL(blob);
        setPortraitPreview({ id: portraitId, url });
      })
      .catch(() => {
        // Keep the emoji fallback when the private preview is temporarily unavailable.
      });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [portraitId]);

  useEffect(() => {
    const account = currentAuthUserId();
    if (!account) return;
    let live = true;
    void fetchCharacterDraft(draftKey, account)
      .then((result) => {
        if (!live) return;
        const restored = result.draft
          ? CharacterDraftSchema.safeParse({
              ...result.draft,
              kind: sourceKind ?? result.draft.kind ?? 'character',
            })
          : null;
        const serverValue = restored?.success ? restored.data : result.draft;
        saver.initialize(result.revision, serverValue);
        setDraftReady(true);
        setAutosaveState(
          serverValue ? '发现在线草稿，请先恢复或手动保存当前内容' : '修改后将自动保存到账号',
        );
        setServerDraft(serverValue);
      })
      .catch((reason: unknown) => {
        if (live) setDraftNotice(reason instanceof Error ? reason.message : '在线草稿暂不可用');
      });
    return () => {
      live = false;
    };
  }, [draftKey, saver, reloadDraft, sourceKind]);

  const collectDraft = (): CharacterDraft | null => {
    const tags = tagsText
      .split(/[,，、\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    const parsed = CharacterDraftSchema.safeParse({
      kind,
      name,
      prompt,
      description,
      icon,
      tags,
      card,
      sourceArchive,
      sourceFileId,
      sourceFileName,
      portraitId,
    });
    if (!parsed.success) {
      setError('角色内容超出限制，请检查名称、Prompt、标签和旧版详细设定');
      return null;
    }
    return parsed.data;
  };

  const restoreDraft = () => {
    if (!serverDraft) return;
    if (dirty && !window.confirm('恢复在线草稿会替换当前未保存的修改，确定继续？')) return;
    setName(serverDraft.name);
    setKind(source ? promptKind(source) : (serverDraft.kind ?? 'character'));
    setPrompt(serverDraft.prompt);
    setDescription(serverDraft.description);
    setIcon(serverDraft.icon);
    setTagsText(serverDraft.tags.join('、'));
    setCard(serverDraft.card);
    setSourceArchive(serverDraft.sourceArchive);
    setOriginalFile(null);
    setSourceFileId(serverDraft.sourceFileId);
    setSourceFileName(serverDraft.sourceFileName);
    setPortraitId(serverDraft.portraitId);
    setPublishSource(
      Boolean(
        serverDraft.sourceArchive &&
        !hasLocalAssetReferences(serverDraft.sourceArchive) &&
        source?.sourceArchive &&
        JSON.stringify(serverDraft.sourceArchive) === JSON.stringify(source.sourceArchive),
      ),
    );
    setImportWarnings([]);
    setSavedFingerprint(
      JSON.stringify({
        ...serverDraft,
        kind: source ? promptKind(source) : (serverDraft.kind ?? 'character'),
      }),
    );
    setServerDraft(null);
    setDraftNotice('已恢复在线草稿');
  };

  const loadVersions = async () => {
    if (!item || historyBusy) return;
    setHistoryBusy(true);
    setHistoryError('');
    try {
      setVersions(await fetchCharacterVersions(item.id));
    } catch (reason) {
      setHistoryError(reason instanceof Error ? reason.message : '角色历史读取失败');
    } finally {
      setHistoryBusy(false);
    }
  };

  const loadVersionIntoEditor = async (revision: number) => {
    if (!item || historyBusy) return;
    setHistoryBusy(true);
    setHistoryError('');
    try {
      const snapshot = await fetchCharacterVersion(item.id, revision);
      setName(snapshot.name);
      setKind(source ? promptKind(source) : promptKind(snapshot.content));
      setPrompt(snapshot.content.prompt);
      setDescription(snapshot.description ?? '');
      setIcon(snapshot.icon ?? '🎭');
      setTagsText(snapshot.tags.join('、'));
      setCard(parseCharacterCard(snapshot.content.characterCard) ?? emptyCharacterCard());
      setSourceArchive(snapshot.content.sourceArchive ?? undefined);
      setOriginalFile(null);
      setSourceFileId(undefined);
      setSourceFileName(undefined);
      setPortraitId(snapshot.content.portraitId ?? undefined);
      setPublishSource(
        Boolean(
          snapshot.content.sourceArchive &&
          !hasLocalAssetReferences(snapshot.content.sourceArchive),
        ),
      );
      setImportWarnings([]);
      setDraftNotice(`已将 v${revision} 载入编辑区；点击“保存修改”才会发布`);
    } catch (reason) {
      setHistoryError(reason instanceof Error ? reason.message : '角色版本读取失败');
    } finally {
      setHistoryBusy(false);
    }
  };

  const importFile = async (file: File) => {
    setError('');
    setBusy(true);
    try {
      const imported = await importExternalCardFile(file);
      setName(imported.name);
      setPrompt(imported.prompt);
      setDescription(imported.description);
      setTagsText(imported.tags.join('、'));
      setCard(imported.card);
      setSourceArchive(imported.archive);
      setOriginalFile(imported.originalFile ?? null);
      setSourceFileId(undefined);
      setSourceFileName(undefined);
      setPublishSource(false);
      setImportWarnings(imported.warnings);
      if (imported.originalFile) {
        const account = currentAuthUserId();
        if (!account) throw new Error('请先登录，才能将完整原文件保存到账号');
        saver.assertCurrent();
        const id = await uploadCharacterContainer(file, account);
        saver.assertCurrent();
        if (currentAuthUserId() !== account) throw new Error('账户已切换，请重新打开编辑器');
        setSourceFileId(id);
        setSourceFileName(file.name);
        setDraftNotice('完整原文件已私密上传；草稿保存后可跨端下载，发布不会自动公开附件');
      } else {
        setDraftNotice(
          `已从 ${imported.container.toUpperCase()} 导入 ${imported.archive.format.toUpperCase()}；请检查后保存草稿或发布`,
        );
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '角色文件导入失败');
    } finally {
      setBusy(false);
    }
  };

  const uploadPendingOriginal = async () => {
    if (!originalFile) return;
    const account = currentAuthUserId();
    if (!account) return setError('请先登录，才能将完整原文件保存到账号');
    setBusy(true);
    setError('');
    try {
      saver.assertCurrent();
      const id = await uploadCharacterContainer(originalFile, account);
      saver.assertCurrent();
      if (currentAuthUserId() !== account) throw new Error('账户已切换，请重新打开编辑器');
      setSourceFileId(id);
      setSourceFileName(originalFile.name);
      setDraftNotice('完整原文件已私密上传；草稿保存后可跨端下载');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '原文件私密上传失败');
    } finally {
      setBusy(false);
    }
  };

  const uploadPortrait = async (file: File) => {
    const account = currentAuthUserId();
    if (!account) {
      setError('请先登录后上传公开头像');
      return false;
    }
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
      file.size > 4 * 1024 * 1024 ||
      file.size === 0
    ) {
      setError('请选择 4 MB 以内的 PNG、JPEG 或 WebP 图片');
      return false;
    }
    setBusy(true);
    setError('');
    try {
      saver.assertCurrent();
      const id = await uploadCharacterPortrait(file);
      saver.assertCurrent();
      if (currentAuthUserId() !== account) throw new Error('账户已切换，请重新打开编辑器');
      setPortraitId(id);
      setDraftNotice('公开头像已上传；保存草稿可跨端继续，发布后才对访客显示');
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '头像上传失败');
      return false;
    } finally {
      saver.resume();
      setBusy(false);
    }
  };

  const removePortrait = async () => {
    if (!portraitId) return;
    if (portraitId === source?.portraitId) {
      setPortraitId(undefined);
      return;
    }
    const account = currentAuthUserId();
    if (!account) return setError('请先登录后清理公开头像');
    const draft = collectDraft();
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      saver.pause();
      const removedDraft = { ...draft, portraitId: undefined };
      await saver.save(removedDraft);
      setSavedFingerprint(JSON.stringify(removedDraft));
      if (currentAuthUserId() !== account) throw new Error('账户已切换，请重新打开编辑器');
      setServerDraft(null);
      const id = portraitId;
      setPortraitId(undefined);
      try {
        await deleteCharacterPortrait(id);
        setDraftNotice('未发布头像已从草稿和素材库删除');
      } catch (reason) {
        setDraftNotice('头像已从草稿移除');
        setError(reason instanceof Error ? reason.message : '素材清理暂不可用');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '草稿更新失败，未删除头像');
    } finally {
      saver.resume();
      setBusy(false);
    }
  };

  const downloadSource = () => {
    if (!sourceArchive) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(sourceArchive.raw, null, 2)], {
        type: 'application/json;charset=utf-8',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name.trim().replace(/[^\w\u4e00-\u9fa5-]+/g, '_') || 'character'}-${sourceArchive.format}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadOriginal = async () => {
    const account = currentAuthUserId();
    if (!account || (!sourceFileId && !originalFile)) return;
    setError('');
    try {
      const blob = originalFile ?? (await fetchCharacterContainer(sourceFileId!, account));
      if (currentAuthUserId() !== account) throw new Error('账户已切换，请重新打开编辑器');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = sourceFileName ?? originalFile?.name ?? 'character.charx';
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '原文件下载失败');
    }
  };

  const loadPrivateContainers = async () => {
    const account = currentAuthUserId();
    if (!account) return setPrivateContainersError('请先登录');
    setPrivateContainersError('');
    try {
      const items = await listCharacterContainers(account);
      if (currentAuthUserId() !== account) throw new Error('账户已切换，请重新打开编辑器');
      setPrivateContainers(items);
    } catch (reason) {
      setPrivateContainersError(reason instanceof Error ? reason.message : '私有原文件读取失败');
    }
  };

  const downloadPrivateContainer = async (entry: PrivateCharacterContainer) => {
    const account = currentAuthUserId();
    if (!account) return;
    try {
      const blob = await fetchCharacterContainer(entry.id, account);
      if (currentAuthUserId() !== account) throw new Error('账户已切换，请重新打开编辑器');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `character-${entry.id}.${entry.type}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setPrivateContainersError(reason instanceof Error ? reason.message : '私有原文件下载失败');
    }
  };

  const removePrivateContainer = async (entry: PrivateCharacterContainer) => {
    if (entry.id === sourceFileId)
      return setPrivateContainersError('请先从当前草稿移除原件并保存，再删除此文件');
    if (draftValue.success && !saver.isSaved(draftValue.data))
      return setPrivateContainersError('请先保存当前草稿，再删除私有原文件');
    if (!window.confirm('删除私有原文件后，其他草稿中对它的引用也将无法下载。确定删除？')) return;
    const account = currentAuthUserId();
    if (!account) return;
    try {
      await deleteCharacterContainer(entry.id, account);
      if (currentAuthUserId() !== account) throw new Error('账户已切换，请重新打开编辑器');
      setPrivateContainers((items) => items?.filter((item) => item.id !== entry.id) ?? null);
      setPrivateContainersError('');
    } catch (reason) {
      setPrivateContainersError(reason instanceof Error ? reason.message : '私有原文件删除失败');
    }
  };

  const saveDraft = async () => {
    const account = currentAuthUserId();
    if (!account) return setError('请先登录后保存草稿');
    const draft = collectDraft();
    if (!draft) return;
    if (originalFile && !sourceFileId)
      return setError('完整原文件尚未保存到账号，请重试上传或移除原件');
    setBusy(true);
    setError('');
    try {
      await saver.save(draft);
      setSavedFingerprint(JSON.stringify(draft));
      setAutosaveState('已保存到账号');
      setServerDraft(null);
      setDraftNotice('草稿已保存到账号，可在其他设备继续编辑');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '在线草稿保存失败');
    } finally {
      saver.resume();
      setBusy(false);
    }
  };

  const save = async () => {
    if (drawingDirty) return setError('请先预览确认手绘头像，或取消绘制，再发布公开内容');
    const account = currentAuthUserId();
    if (!account) return setError('请先登录后保存公开内容');
    if (!name.trim()) return setError('请填写名称');
    if (!prompt.trim()) return setError('请填写基础 Prompt');
    if (prompt.length > MAX_SCENARIO_PROMPT_LENGTH)
      return setError(`Prompt 最多 ${MAX_SCENARIO_PROMPT_LENGTH} 字，编辑内容已保留`);
    if (kind === 'character' && !parseCharacterCard(card))
      return setError('旧版详细设定超出限制，编辑内容已保留');
    const draft = collectDraft();
    if (!draft) return;
    if (originalFile && !sourceFileId)
      return setError('完整原文件尚未保存到账号，请重试上传或移除原件');
    if (
      sourceArchive &&
      publishSource &&
      !window.confirm(
        '原始 JSON 可能包含私人资料、第三方文本与版权内容。请确认你有公开传播权，且已检查隐私与使用许可。确定公开发布原始 JSON？',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      saver.pause();
      const publishedDraftRevision = await saver.save(draft);
      setSavedFingerprint(JSON.stringify(draft));
      let id = item?.id;
      if (id) {
        await updateItem(id, {
          expectedRevision: item?.revision ?? 1,
          name: name.trim(),
          description: description.trim(),
          icon: icon.trim(),
          tags: draft.tags,
          content: {
            prompt,
            kind,
            ...(kind === 'character' ? { characterCard: card } : {}),
            ...(kind === 'character' && (portraitId || source?.portraitId)
              ? { portraitId: portraitId ?? null }
              : {}),
            ...(kind === 'character' && sourceArchive && publishSource
              ? { sourceArchive }
              : kind === 'character' && source?.sourceArchive
                ? { sourceArchive: null }
                : {}),
          },
        });
      } else {
        const payload: UploadPayload = {
          type: 'scenario',
          name: name.trim(),
          description: description.trim(),
          icon: icon.trim(),
          tags: draft.tags,
          content: {
            prompt,
            kind,
            ...(kind === 'character' ? { characterCard: card } : {}),
            ...(kind === 'character' && portraitId ? { portraitId } : {}),
            ...(kind === 'character' && sourceArchive && publishSource ? { sourceArchive } : {}),
          },
        };
        id = (await uploadItem(payload)).id;
      }
      if (currentAuthUserId() !== account) throw new Error('账号已切换，请重新打开公开内容');
      saver.assertCurrent();
      published.current = true;
      if (publishedDraftRevision !== null && !sourceFileId)
        await deleteCharacterDraft(draftKey, account, publishedDraftRevision).catch(
          () => undefined,
        );
      saver.assertCurrent();
      onSaved(id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '公开内容保存失败');
    } finally {
      saver.resume();
      setBusy(false);
    }
  };

  if (accountChanged)
    return (
      <main className="character-studio">
        <p role="alert">账户已切换，旧编辑器已停止保存。请关闭后重新打开。</p>
        <Button onClick={onClose}>返回发现</Button>
      </main>
    );
  return (
    <main
      className="character-studio"
      aria-label={
        item
          ? `编辑公开${kind === 'character' ? '角色' : '场景'}`
          : `创建公开${kind === 'character' ? '角色' : '场景'}`
      }
    >
      <header className="character-studio-head">
        <div>
          <p className="character-studio-eyebrow">Market · 公开 Prompt 创作</p>
          <h1>
            {item ? '编辑' : '创建'}
            {kind === 'character' ? '角色' : '场景'}
          </h1>
          <p>
            {kind === 'character'
              ? '角色拥有公开人设；每位用户的名字、关系和记忆由自己的聊天设置管理。'
              : '场景只定义环境与规则，可应用到聊天，不拥有独立关系或记忆。'}
          </p>
        </div>
        <Button variant="secondary" onClick={closeEditor} disabled={busy}>
          返回发现
        </Button>
      </header>

      <div className="character-studio-grid">
        <fieldset disabled={busy} className="character-studio-form" aria-label="公开 Prompt 设定">
          {serverDraft && (
            <div className="character-studio-draft">
              <span>发现此账号保存的在线草稿</span>
              <Button variant="secondary" onClick={restoreDraft} disabled={busy}>
                恢复草稿
              </Button>
            </div>
          )}
          <p role="status">
            {autosaveState}
            {dirty ? ' · 当前仍有未保存修改' : ''}
            {originalFile ? ' · 原文件附件仅在此页面' : ''}
          </p>
          {owner && (
            <Button
              variant="ghost"
              disabled={busy || autosaveState === '正在自动保存…'}
              onClick={() => {
                setDraftReady(false);
                setReloadDraft((value) => value + 1);
              }}
            >
              重新读取在线草稿
            </Button>
          )}
          {!draftValue.success && (
            <p role="alert">内容超出草稿限制，自动保存已暂停；请调整后再保存。</p>
          )}
          {draftNotice && <p className="character-studio-draft-notice">{draftNotice}</p>}
          {kind === 'character' && (
            <details ref={importDetails} className="character-studio-import">
              <summary>导入已有角色文件（可选）</summary>
              <label className="field">
                <span>导入 CCv2／CCv3 角色文件</span>
                <input
                  type="file"
                  accept=".json,.png,.apng,.charx,application/json,image/png"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file) void importFile(file);
                    event.currentTarget.value = '';
                  }}
                  disabled={busy}
                />
              </label>
              <small>
                支持 JSON、PNG/APNG、CHARX；完整原文件私密保存到账号，发布只包含明确选择的
                JSON，不自动公开图片或附件。
              </small>
              {(originalFile || sourceFileId) && (
                <div className="character-studio-source">
                  <span>
                    {sourceFileId ? '账号私有原文件' : '待上传原文件'}：
                    {sourceFileName ?? originalFile?.name}
                  </span>
                  <Button
                    variant="secondary"
                    onClick={() => void downloadOriginal()}
                    disabled={busy}
                  >
                    下载完整原文件
                  </Button>
                  {originalFile && !sourceFileId && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void uploadPendingOriginal()}
                    >
                      重试私密上传
                    </Button>
                  )}
                </div>
              )}
              <Button variant="ghost" onClick={() => void loadPrivateContainers()} disabled={busy}>
                管理私有原文件
              </Button>
              {privateContainersError && <p role="alert">{privateContainersError}</p>}
              {privateContainers && (
                <div className="character-studio-source">
                  {privateContainers.length === 0 && <span>暂无私有原文件</span>}
                  {privateContainers.map((entry) => (
                    <div key={entry.id}>
                      <span>
                        {entry.type.toUpperCase()} · {(entry.bytes / 1_000_000).toFixed(2)} MB ·{' '}
                        {entry.id.slice(0, 8)}
                      </span>
                      <Button
                        variant="secondary"
                        onClick={() => void downloadPrivateContainer(entry)}
                      >
                        下载
                      </Button>
                      <Button variant="ghost" onClick={() => void removePrivateContainer(entry)}>
                        删除
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {importWarnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
              {sourceArchive && (
                <div className="character-studio-source">
                  <span>已保留 {sourceArchive.format.toUpperCase()} 原件</span>
                  <Button variant="secondary" onClick={downloadSource} disabled={busy}>
                    下载原始 JSON
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setSourceArchive(undefined);
                      setOriginalFile(null);
                      setSourceFileId(undefined);
                      setSourceFileName(undefined);
                      setPublishSource(false);
                      setImportWarnings([]);
                    }}
                    disabled={busy}
                  >
                    移除原件
                  </Button>
                  <label>
                    <input
                      type="checkbox"
                      checked={publishSource}
                      disabled={unresolvedAssets}
                      onChange={(event) => setPublishSource(event.target.checked)}
                    />
                    原始 JSON 随角色公开发布（可能包含扩展字段；请先检查隐私与使用权）
                  </label>
                  {!publishSource && (
                    <small>不勾选时只发布当前人设，原件不会随公开角色保存。</small>
                  )}
                  {unresolvedAssets && (
                    <small>
                      原始 JSON 引用了当前未公开的附件；可保留在私有草稿，公开时仅发布人物设定。
                    </small>
                  )}
                </div>
              )}
            </details>
          )}
          <label className="field">
            <span>名称</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={60}
              placeholder={kind === 'character' ? '给角色起个名字' : '给场景起个名字'}
            />
          </label>
          <label className="field">
            <span>基础 Prompt</span>
            <textarea
              aria-label="基础 Prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={13}
              placeholder={
                kind === 'character' ? '描述人物是谁、如何交流…' : '描述环境、规则和氛围…'
              }
            />
            <small>
              {prompt.length} / {MAX_SCENARIO_PROMPT_LENGTH} 字
            </small>
          </label>
          <label className="field">
            <span>{kind === 'character' ? '头像符号' : '场景图标'}</span>
            <input
              value={icon}
              onChange={(event) => setIcon(event.target.value)}
              maxLength={8}
              placeholder="🎭"
            />
          </label>
          {kind === 'character' && (
            <label className="field">
              <span>公开角色头像（可选）</span>
              <input
                type="file"
                aria-label="公开角色头像"
                accept="image/jpeg,image/png,image/webp"
                disabled={busy}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) void uploadPortrait(file);
                  event.currentTarget.value = '';
                }}
              />
              <small>最大 4 MB。发布后所有人可见；私人头像在聊天设置中管理。</small>
            </label>
          )}
          {kind === 'character' && (
            <Button
              variant="secondary"
              disabled={busy || drawingOpen}
              onClick={() => setDrawingOpen(true)}
            >
              绘制公开头像
            </Button>
          )}
          {kind === 'character' && drawingOpen && (
            <CharacterStudioDrawing
              onDirtyChange={setDrawingDirty}
              onClose={() => {
                setDrawingOpen(false);
                setDrawingDirty(false);
              }}
              onSave={async (blob) => {
                const success = await uploadPortrait(
                  new File([blob], 'character-drawing.png', { type: 'image/png' }),
                );
                if (!success) throw new Error('头像未上传，请查看错误后重试；画板已保留');
              }}
            />
          )}
          {kind === 'character' && portraitId && (
            <Button variant="ghost" disabled={busy} onClick={() => void removePortrait()}>
              {portraitId === source?.portraitId ? '移除公开头像' : '移除并清理未发布头像'}
            </Button>
          )}
          <details className="character-studio-publish">
            <summary>发布资料（可选）</summary>
            <label className="field">
              <span>简介</span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                maxLength={500}
              />
            </label>
            <label className="field">
              <span>标签（逗号分隔）</span>
              <input
                value={tagsText}
                onChange={(event) => setTagsText(event.target.value)}
                placeholder="朋友、幻想、学习"
              />
            </label>
          </details>
          {kind === 'character' && (
            <details className="character-studio-publish">
              <summary>详细人设（可选）</summary>
              <CharacterCardFields
                value={card}
                onChange={(next) => setCard(next ?? emptyCharacterCard())}
                allowRemove={false}
              />
            </details>
          )}
          {item && (
            <details
              className="character-studio-history"
              onToggle={(event) => {
                if (event.currentTarget.open) void loadVersions();
              }}
            >
              <summary>公开版本历史</summary>
              {historyBusy && <p>读取中…</p>}
              {historyError && (
                <p role="alert" className="error">
                  {historyError}
                </p>
              )}
              {versions.map((version) => (
                <div key={version.revision} className="character-studio-history-row">
                  <span>
                    v{version.revision} · {version.name}
                    {version.current ? '（当前）' : ''}
                  </span>
                  {!version.current && (
                    <Button
                      variant="secondary"
                      disabled={historyBusy || busy}
                      onClick={() => void loadVersionIntoEditor(version.revision)}
                    >
                      载入编辑区
                    </Button>
                  )}
                </div>
              ))}
            </details>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="character-studio-actions">
            <Button
              variant="secondary"
              onClick={() => void saveDraft()}
              disabled={busy || !draftReady}
            >
              {serverDraft ? '用当前内容替换在线草稿' : '保存在线草稿'}
            </Button>
            <Button onClick={() => void save()} disabled={busy || !draftReady}>
              {busy
                ? '保存中…'
                : item
                  ? '保存修改'
                  : `发布${kind === 'character' ? '角色' : '场景'}`}
            </Button>
            <Button variant="ghost" onClick={closeEditor} disabled={busy}>
              取消
            </Button>
          </div>
        </fieldset>

        <aside className="character-studio-preview" aria-label="公开卡片预览">
          <p className="character-studio-eyebrow">公开卡片预览</p>
          <div className="character-studio-portrait" aria-hidden="true">
            {portraitPreview && portraitPreview.id === portraitId ? (
              <img src={portraitPreview.url} alt="" />
            ) : (
              icon || '🎭'
            )}
          </div>
          <h2>{name.trim() || '公开卡名称'}</h2>
          <p>
            {description.trim() ||
              (kind === 'character'
                ? '发布后，其他用户可以创建自己的角色关系。'
                : '发布后，其他用户可以将这份环境设定用于聊天。')}
          </p>
          <div className="character-studio-prompt-preview">
            <strong>基础 Prompt</strong>
            <p>{prompt.trim() || '输入 Prompt 后在这里预览。'}</p>
          </div>
          <small>公开卡只定义人物或场景，不包含任何人的专属记忆或设备权限。</small>
        </aside>
      </div>
      {kind === 'character' && (
        <CharacterStudioPreview key={fingerprint} snapshot={{ name, prompt, card }} />
      )}
    </main>
  );
}
