import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, type CampaignItem } from '../../lib/api.js';
import {
  clearLocalDraftRecovery,
  getDraftRecoveryStorageKey,
  readLocalDraftRecovery,
  writeLocalDraftRecovery,
  type AutosaveState,
  type BroadcastDraftPayload,
  type StoredLocalRecovery,
} from './marketingDraftHelpers.js';

export {
  clearLocalDraftRecovery,
  getDraftRecoveryStorageKey,
  readLocalDraftRecovery,
  writeLocalDraftRecovery,
  type AutosaveState,
  type BroadcastDraftPayload,
  type StoredLocalRecovery,
};

function buildApiPayload(
  draft: BroadcastDraftPayload,
  expectedUpdatedAt: string | null,
  includeStatusScheduled: boolean
) {
  let scheduledIso: string | null = null;
  if (draft.deliveryChoice === 'schedule' && draft.scheduledLocal) {
    const d = new Date(draft.scheduledLocal);
    if (!Number.isNaN(d.getTime())) scheduledIso = d.toISOString();
  }
  return {
    domainId: draft.domainId,
    ...(draft.templateId ? { templateId: draft.templateId } : {}),
    name: draft.name.trim() || 'Untitled Broadcast',
    ...(draft.fromName ? { fromName: draft.fromName } : { fromName: '' }),
    fromEmail: draft.fromEmail.trim() || null,
    replyTo: draft.replyTo.trim() || null,
    subject: draft.subject || null,
    previewText: draft.previewText,
    htmlBody: draft.htmlBody || null,
    textBody: draft.textBody || null,
    blocksJson: draft.blocks,
    audienceSpec: draft.audienceSpec,
    timezone: draft.timezone || 'UTC',
    scheduledAt: scheduledIso,
    tagFilter: null as string | null,
    ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
    ...(includeStatusScheduled && scheduledIso ? { status: 'scheduled' as const } : {}),
  };
}

export function useBroadcastDraftAutosave({
  initialCampaignId,
  initialUpdatedAt,
  draft,
  isLocked,
  onCampaignIdAssigned,
  onServerSaved,
}: {
  initialCampaignId: string | null;
  initialUpdatedAt: string | null;
  draft: BroadcastDraftPayload;
  isLocked: boolean;
  onCampaignIdAssigned: (id: string, campaign: CampaignItem) => void;
  onServerSaved: (campaign: CampaignItem) => void;
}) {
  const [campaignId, setCampaignId] = useState<string | null>(initialCampaignId);
  const [saveState, setSaveState] = useState<AutosaveState>(
    typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : initialCampaignId ? 'saved' : 'idle'
  );
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(initialUpdatedAt);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflictCampaign, setConflictCampaign] = useState<CampaignItem | null>(null);

  const revisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  const serverUpdatedAtRef = useRef<string | null>(initialUpdatedAt);
  const campaignIdRef = useRef<string | null>(initialCampaignId);
  const latestDraftRef = useRef<BroadcastDraftPayload>(draft);
  const queuePromiseRef = useRef<Promise<CampaignItem | null>>(Promise.resolve(null));
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  latestDraftRef.current = draft;

  const performServerPersist = useCallback(
    (forceOverwriteConflict = false): Promise<CampaignItem | null> => {
      const targetRevision = revisionRef.current;
      const run = queuePromiseRef.current.then(async (): Promise<CampaignItem | null> => {
        const snapshot = latestDraftRef.current;
        if (isLocked) return null;
        if (!snapshot.domainId) {
          setSaveState('unsaved');
          return null;
        }
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          setSaveState('offline');
          writeLocalDraftRecovery(campaignIdRef.current, {
            draft: snapshot,
            serverUpdatedAt: serverUpdatedAtRef.current,
            dirty: true,
            savedLocallyAt: Date.now(),
          });
          return null;
        }

        setSaveState('saving');
        setSaveError(null);

        try {
          let saved: CampaignItem;
          if (!campaignIdRef.current) {
            const payload = buildApiPayload(snapshot, null, false);
            const res = await api.createCampaign(payload);
            saved = res.campaign;
            campaignIdRef.current = saved.id;
            setCampaignId(saved.id);
            clearLocalDraftRecovery(null);
            onCampaignIdAssigned(saved.id, saved);
          } else {
            const expectedTs = forceOverwriteConflict ? null : serverUpdatedAtRef.current;
            const payload = buildApiPayload(snapshot, expectedTs, false);
            const res = await api.updateCampaign(campaignIdRef.current, payload);
            saved = res.campaign;
          }

          serverUpdatedAtRef.current = saved.updatedAt ?? saved.createdAt;
          savedRevisionRef.current = Math.max(savedRevisionRef.current, targetRevision);
          setLastSavedAt(serverUpdatedAtRef.current);
          setConflictCampaign(null);
          onServerSaved(saved);

          const stillDirty = revisionRef.current > savedRevisionRef.current;
          setSaveState(stillDirty ? 'unsaved' : 'saved');
          writeLocalDraftRecovery(campaignIdRef.current, {
            draft: latestDraftRef.current,
            serverUpdatedAt: serverUpdatedAtRef.current,
            dirty: stillDirty,
            savedLocallyAt: Date.now(),
          });
          return saved;
        } catch (err) {
          if (err instanceof ApiError && err.status === 409 && err.code === 'DRAFT_CONFLICT') {
            const detailsObj =
              err.extra?.details && typeof err.extra.details === 'object'
                ? (err.extra.details as Record<string, unknown>)
                : undefined;
            const latest =
              (detailsObj?.latestCampaign as CampaignItem | undefined) ??
              (err.extra?.latestCampaign as CampaignItem | undefined) ??
              null;
            setConflictCampaign(latest);
            setSaveState('conflict');
            setSaveError('Another session modified this draft. Choose which version to keep.');
          } else if (err instanceof ApiError && err.status === 409 && err.code === 'CAMPAIGN_LOCKED') {
            setSaveState('error');
            setSaveError(err.message);
          } else {
            setSaveState(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error');
            setSaveError(err instanceof Error ? err.message : 'Autosave failed');
          }
          writeLocalDraftRecovery(campaignIdRef.current, {
            draft: latestDraftRef.current,
            serverUpdatedAt: serverUpdatedAtRef.current,
            dirty: true,
            savedLocallyAt: Date.now(),
          });
          return null;
        }
      });

      queuePromiseRef.current = run.catch(() => null);
      return queuePromiseRef.current;
    },
    [isLocked, onCampaignIdAssigned, onServerSaved]
  );

  const scheduleAutosave = useCallback(
    (nextDraft: BroadcastDraftPayload) => {
      if (isLocked) return;
      revisionRef.current += 1;
      latestDraftRef.current = nextDraft;

      writeLocalDraftRecovery(campaignIdRef.current, {
        draft: nextDraft,
        serverUpdatedAt: serverUpdatedAtRef.current,
        dirty: true,
        savedLocallyAt: Date.now(),
      });

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setSaveState('offline');
        return;
      }

      setSaveState('unsaved');
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        void performServerPersist(false);
      }, 1000);
    },
    [isLocked, performServerPersist]
  );

  const flushNow = useCallback(
    async (forceOverwrite = false): Promise<CampaignItem | null> => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (isLocked) return null;
      return performServerPersist(forceOverwrite);
    },
    [isLocked, performServerPersist]
  );

  const acceptServerConflictVersion = useCallback((latest: CampaignItem) => {
    serverUpdatedAtRef.current = latest.updatedAt ?? latest.createdAt;
    savedRevisionRef.current = revisionRef.current;
    setConflictCampaign(null);
    setSaveError(null);
    setLastSavedAt(serverUpdatedAtRef.current);
    setSaveState('saved');
    clearLocalDraftRecovery(latest.id);
  }, []);

  useEffect(() => {
    const onOffline = () => {
      setSaveState('offline');
    };
    const onOnline = () => {
      if (revisionRef.current > savedRevisionRef.current) {
        void performServerPersist(false);
      }
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [performServerPersist]);

  return {
    campaignId,
    saveState,
    lastSavedAt,
    saveError,
    conflictCampaign,
    scheduleAutosave,
    flushNow,
    acceptServerConflictVersion,
    serverUpdatedAtRef,
  };
}
