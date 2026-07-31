import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Eye,
  LoaderCircle,
  Ruler,
  ShieldAlert,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SCOPE_PHOTO_MAX_BYTES, type ScopePhotoContext } from '@/core/scopePhotos/contracts';
import { getLiveStoryOpsRepository, readLiveRepositoryConfig } from '@/state/liveRepository';
import type { AppRole } from '@/state/model';
import { Badge, Button, Card, Field } from './ui/Primitives';

type MeasurementKind =
  'area_sq_ft' | 'length_linear_ft' | 'height_ft' | 'count' | 'stories' | 'duration_hours';

const measurementUnits: Record<
  MeasurementKind,
  'sq_ft' | 'linear_ft' | 'ft' | 'each' | 'story' | 'hour'
> = {
  area_sq_ft: 'sq_ft',
  length_linear_ft: 'linear_ft',
  height_ft: 'ft',
  count: 'each',
  stories: 'story',
  duration_hours: 'hour',
};

function percent(value: number | string): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${Math.round(numeric * 100)}%` : 'unknown';
}

export function ScopePhotoCapturePanel({
  propertyId,
  customerId,
  role,
  serviceCodes,
  onEvidenceChanged,
}: {
  propertyId: string;
  customerId?: string;
  role: AppRole;
  serviceCodes?: string[];
  onEvidenceChanged?: () => void;
}) {
  const repository = useMemo(() => getLiveStoryOpsRepository(readLiveRepositoryConfig()), []);
  const [context, setContext] = useState<ScopePhotoContext>();
  const [loading, setLoading] = useState(Boolean(repository));
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string | undefined>(
    repository ? undefined : 'Private scope-photo storage is not configured.',
  );
  const [requestNote, setRequestNote] = useState('');
  const commandReservations = useRef(new Map<string, string>());
  const [measurement, setMeasurement] = useState<{
    requestId: string;
    assetId: string;
    analysisId: string | null;
    kind: MeasurementKind;
    label: string;
    value: string;
    serviceCode: string;
    confirmationNote: string;
  }>({
    requestId: '',
    assetId: '',
    analysisId: null,
    kind: 'area_sq_ft',
    label: '',
    value: '',
    serviceCode: serviceCodes?.[0] ?? '',
    confirmationNote: '',
  });
  const [review, setReview] = useState({
    requestId: '',
    disposition: 'site_verification_required' as
      'confirmed_for_estimate' | 'site_verification_required' | 'more_photos_required',
    accessDecision: '',
    riskDecision: '',
    unknowns: '',
  });

  const refresh = useCallback(async () => {
    if (!repository) {
      setError('Private scope-photo storage is not configured.');
      setLoading(false);
      return;
    }
    try {
      const loaded = await repository.loadScopePhotoContext(propertyId);
      setContext(loaded);
      setError(undefined);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Scope-photo evidence could not be loaded.',
      );
    } finally {
      setLoading(false);
    }
  }, [propertyId, repository]);

  useEffect(() => {
    if (!repository) return;
    let active = true;
    void repository
      .loadScopePhotoContext(propertyId)
      .then((loaded) => {
        if (!active) return;
        setContext(loaded);
        setError(undefined);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setError(
          caught instanceof Error ? caught.message : 'Scope-photo evidence could not be loaded.',
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [propertyId, repository]);

  const requests = useMemo(() => context?.requests ?? [], [context]);
  const activeRequest = useMemo(
    () => requests.find((request) => ['open', 'submitted'].includes(request.status)),
    [requests],
  );
  const submissions = useMemo(
    () =>
      activeRequest
        ? (context?.submissions.filter((item) => item.requestId === activeRequest.id) ?? [])
        : [],
    [activeRequest, context],
  );
  const allUnknowns = useMemo(
    () => [...new Set(submissions.flatMap((submission) => submission.analysis?.unknowns ?? []))],
    [submissions],
  );
  const isBackOffice = role === 'owner' || role === 'dispatcher';
  const measurementForm =
    activeRequest && measurement.requestId !== activeRequest.id
      ? {
          ...measurement,
          requestId: activeRequest.id,
          assetId: submissions[0]?.assetId ?? '',
          analysisId: submissions.find((submission) => submission.analysis)?.analysis?.id ?? null,
          label: '',
          value: '',
          serviceCode: serviceCodes?.[0] ?? '',
          confirmationNote: '',
        }
      : measurement;
  const reviewForm =
    activeRequest && review.requestId !== activeRequest.id
      ? {
          ...review,
          requestId: activeRequest.id,
          unknowns: allUnknowns.join('\n'),
          accessDecision: '',
          riskDecision: '',
        }
      : review;

  const perform = async (key: string, operation: () => Promise<void>) => {
    setBusy(key);
    setError(undefined);
    try {
      await operation();
      await refresh();
      onEvidenceChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The scope-photo action failed.');
    } finally {
      setBusy(undefined);
    }
  };

  const createRequest = () => {
    if (!repository || !customerId) return;
    const reservationKey = `request:${customerId}:${propertyId}:${requestNote}`;
    const idempotencyKey =
      commandReservations.current.get(reservationKey) ?? `scope-request:${crypto.randomUUID()}`;
    commandReservations.current.set(reservationKey, idempotencyKey);
    void perform('request', async () => {
      await repository.createScopePhotoRequest({
        customerId,
        propertyId,
        note: requestNote,
        idempotencyKey,
      });
      commandReservations.current.delete(reservationKey);
      setRequestNote('');
    });
  };

  const upload = (checklistItemCode: string, file: File) => {
    if (!repository || !activeRequest) return;
    const commandId = crypto.randomUUID();
    void perform(`upload:${checklistItemCode}`, async () => {
      await repository.uploadScopePhoto({
        requestId: activeRequest.id,
        checklistItemCode,
        file,
        commandId,
      });
    });
  };

  const analyze = (assetId: string) => {
    if (!repository) return;
    const reservationKey = `analysis:${assetId}`;
    const idempotencyKey =
      commandReservations.current.get(reservationKey) ?? `scope-analysis:${crypto.randomUUID()}`;
    commandReservations.current.set(reservationKey, idempotencyKey);
    void perform(reservationKey, async () => {
      await repository.analyzeScopePhoto({ propertyId, assetId, idempotencyKey });
      commandReservations.current.delete(reservationKey);
    });
  };

  const confirmMeasurement = () => {
    if (!repository || !measurementForm.requestId || !measurementForm.assetId) return;
    const idempotencyKey = `scope-measurement:${crypto.randomUUID()}`;
    void perform('measurement', async () => {
      await repository.confirmScopePhotoMeasurement({
        requestId: measurementForm.requestId,
        analysisId: measurementForm.analysisId,
        sourceAssetIds: [measurementForm.assetId],
        kind: measurementForm.kind,
        label: measurementForm.label,
        value: measurementForm.value,
        unit: measurementUnits[measurementForm.kind],
        serviceCodes: [measurementForm.serviceCode],
        addOnCodes: [],
        confirmationNote: measurementForm.confirmationNote,
        idempotencyKey,
      });
      setMeasurement((current) => ({
        ...current,
        label: '',
        value: '',
        confirmationNote: '',
      }));
    });
  };

  const recordReview = () => {
    if (!repository || !activeRequest) return;
    void perform('review', async () => {
      await repository.reviewScopePhotoRequest({
        requestId: activeRequest.id,
        disposition: reviewForm.disposition,
        accessDecision: reviewForm.accessDecision,
        riskDecision: reviewForm.riskDecision,
        unresolvedUnknowns: reviewForm.unknowns
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean),
        idempotencyKey: `scope-review:${crypto.randomUUID()}`,
      });
    });
  };

  if (loading) {
    return (
      <Card className="estimate-section scope-photo-panel">
        <div className="scope-photo-panel__loading" role="status">
          <LoaderCircle className="spin" size={18} /> Loading private scope evidence…
        </div>
      </Card>
    );
  }

  return (
    <Card className="estimate-section scope-photo-panel">
      <div className="section-card__header">
        <div>
          <h2>Photo-assisted scope</h2>
          <p className="section-card__subtitle">
            Private evidence and human confirmation; vision never supplies a price
          </p>
        </div>
        <Badge tone={activeRequest ? 'info' : 'neutral'} dot>
          {activeRequest
            ? `${activeRequest.photoCount}/${activeRequest.maximumPhotos} photos`
            : 'No open request'}
        </Badge>
      </div>

      {error && (
        <div className="projection-warning" role="alert">
          <AlertTriangle size={17} />
          <div>
            <strong>Scope evidence action blocked</strong>
            <p>{error}</p>
          </div>
        </div>
      )}

      {!activeRequest && isBackOffice && (
        <div className="scope-photo-panel__request">
          <Field
            label="Customer request note"
            htmlFor="scope-request-note"
            hint="No quote, measurement, or provider-delivery claim is included."
          >
            <textarea
              id="scope-request-note"
              value={requestNote}
              maxLength={500}
              onChange={(event) => setRequestNote(event.target.value)}
              placeholder="Please photograph each side of the property and any access concern."
            />
          </Field>
          <Button
            icon={<Camera size={15} />}
            disabled={!customerId || Boolean(busy)}
            onClick={createRequest}
          >
            Create private checklist
          </Button>
        </div>
      )}

      {!activeRequest && role === 'customer' && (
        <div className="scope-photo-panel__empty">
          <Camera size={20} />
          <p>The office has not requested property scope photos.</p>
        </div>
      )}

      {activeRequest && (
        <>
          <div className="scope-photo-panel__notice">
            <ShieldAlert size={16} />
            <p>
              JPEG, PNG, or WebP only; 10 MiB each, {activeRequest.maximumPhotos} maximum. Files use
              private, content-addressed storage and an expiring upload reservation.
            </p>
          </div>
          <div className="scope-photo-checklist">
            {activeRequest.checklist.map((item) => {
              const itemSubmissions = submissions.filter(
                (submission) => submission.checklistItemCode === item.code,
              );
              const itemBusy = busy === `upload:${item.code}`;
              return (
                <div className="scope-photo-checklist__item" key={item.code}>
                  <div>
                    <span className="scope-photo-checklist__status">
                      {itemSubmissions.length > 0 ? (
                        <CheckCircle2 size={16} />
                      ) : (
                        <Camera size={16} />
                      )}
                    </span>
                    <div>
                      <strong>
                        {item.label}{' '}
                        {item.required ? <small>Required</small> : <small>Optional</small>}
                      </strong>
                      <p>{item.guidance}</p>
                    </div>
                  </div>
                  <label
                    className={`button button--secondary button--sm ${
                      itemBusy || itemSubmissions.length >= item.maximumPhotos ? 'is-disabled' : ''
                    }`}
                  >
                    {itemBusy ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}
                    {itemSubmissions.length >= item.maximumPhotos ? 'Limit reached' : 'Add photo'}
                    <input
                      className="visually-hidden"
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      capture="environment"
                      disabled={
                        Boolean(busy) ||
                        itemSubmissions.length >= item.maximumPhotos ||
                        activeRequest.photoCount >= activeRequest.maximumPhotos
                      }
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) upload(item.code, file);
                        event.target.value = '';
                      }}
                    />
                  </label>
                </div>
              );
            })}
          </div>

          {isBackOffice && submissions.length > 0 && (
            <div className="scope-photo-analyses">
              <div className="scope-photo-panel__subhead">
                <Eye size={17} />
                <div>
                  <h3>Advisory evidence</h3>
                  <p>Confidence and unknowns remain visible; no flag selects a price multiplier.</p>
                </div>
              </div>
              {submissions.map((submission) => (
                <div className="scope-photo-analysis" key={submission.id}>
                  <div className="scope-photo-analysis__header">
                    <div>
                      <strong>{submission.checklistItemCode.replaceAll('_', ' ')}</strong>
                      <span>
                        {(submission.byteSize / 1024 / 1024).toFixed(1)} MiB · checksum{' '}
                        {submission.checksumSha256.slice(0, 12)}…
                      </span>
                    </div>
                    {submission.analysis ? (
                      <Badge
                        tone={
                          submission.analysis.disposition === 'usable_for_scope'
                            ? 'positive'
                            : 'warning'
                        }
                      >
                        {percent(submission.analysis.overallConfidence)} confidence
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={Boolean(busy)}
                        onClick={() => analyze(submission.assetId)}
                      >
                        {busy === `analysis:${submission.assetId}`
                          ? 'Analyzing…'
                          : 'Analyze evidence'}
                      </Button>
                    )}
                  </div>
                  {submission.analysis && (
                    <div className="scope-photo-analysis__evidence">
                      {submission.analysis.observations.map((observation) => (
                        <p key={`${submission.id}:${observation.label}`}>
                          <strong>{observation.label}</strong> — {observation.evidence}{' '}
                          <small>{percent(observation.confidence)}</small>
                        </p>
                      ))}
                      {[...submission.analysis.accessFlags, ...submission.analysis.riskFlags].map(
                        (flag) => (
                          <p key={`${submission.id}:${flag.code}`}>
                            <ShieldAlert size={13} /> <strong>{flag.label}</strong> —{' '}
                            {flag.evidence}{' '}
                            <small>
                              {flag.status} · {percent(flag.confidence)}
                            </small>
                          </p>
                        ),
                      )}
                      {submission.analysis.unknowns.map((unknown) => (
                        <p className="scope-photo-analysis__unknown" key={unknown}>
                          <AlertTriangle size={13} /> Unknown: {unknown}
                        </p>
                      ))}
                      {submission.analysis.measurementCandidates.map((candidate, index) => (
                        <p
                          className="scope-photo-analysis__candidate"
                          key={`${candidate.dimension}:${index}`}
                        >
                          <Ruler size={13} /> Model candidate:{' '}
                          {candidate.dimension.replaceAll('_', ' ')}
                          {candidate.value ? ` ${candidate.value}` : ' — no value'} ·{' '}
                          {percent(candidate.confidence)}. Human measurement required.
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {isBackOffice && submissions.length > 0 && (
            <div className="scope-photo-human-grid">
              <section>
                <div className="scope-photo-panel__subhead">
                  <Ruler size={17} />
                  <div>
                    <h3>Confirm a measurement</h3>
                    <p>
                      Enter what a person verified; model candidates are never copied automatically.
                    </p>
                  </div>
                </div>
                <div className="form-grid form-grid--2">
                  <Field label="Source photo" htmlFor="scope-measurement-asset">
                    <select
                      id="scope-measurement-asset"
                      value={measurementForm.assetId}
                      onChange={(event) => {
                        const selected = submissions.find(
                          (item) => item.assetId === event.target.value,
                        );
                        setMeasurement({
                          ...measurementForm,
                          assetId: event.target.value,
                          analysisId: selected?.analysis?.id ?? null,
                        });
                      }}
                    >
                      {submissions.map((submission) => (
                        <option key={submission.assetId} value={submission.assetId}>
                          {submission.checklistItemCode.replaceAll('_', ' ')} ·{' '}
                          {submission.checksumSha256.slice(0, 8)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Measurement kind" htmlFor="scope-measurement-kind">
                    <select
                      id="scope-measurement-kind"
                      value={measurementForm.kind}
                      onChange={(event) =>
                        setMeasurement({
                          ...measurementForm,
                          kind: event.target.value as MeasurementKind,
                        })
                      }
                    >
                      <option value="area_sq_ft">Area (sq ft)</option>
                      <option value="length_linear_ft">Length (linear ft)</option>
                      <option value="height_ft">Height (ft)</option>
                      <option value="count">Count (each)</option>
                      <option value="stories">Stories</option>
                      <option value="duration_hours">Duration (hours)</option>
                    </select>
                  </Field>
                  <Field label="Human label" htmlFor="scope-measurement-label">
                    <input
                      id="scope-measurement-label"
                      value={measurementForm.label}
                      maxLength={160}
                      onChange={(event) =>
                        setMeasurement({ ...measurementForm, label: event.target.value })
                      }
                      placeholder="Driveway area"
                    />
                  </Field>
                  <Field
                    label={`Verified value (${measurementUnits[measurementForm.kind].replaceAll('_', ' ')})`}
                    htmlFor="scope-measurement-value"
                  >
                    <input
                      id="scope-measurement-value"
                      inputMode="decimal"
                      value={measurementForm.value}
                      onChange={(event) =>
                        setMeasurement({ ...measurementForm, value: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Service classification" htmlFor="scope-measurement-service">
                    <select
                      id="scope-measurement-service"
                      value={measurementForm.serviceCode}
                      onChange={(event) =>
                        setMeasurement({
                          ...measurementForm,
                          serviceCode: event.target.value,
                        })
                      }
                    >
                      <option value="">Select active service…</option>
                      {(serviceCodes ?? []).map((code) => (
                        <option key={code} value={code}>
                          {code.replaceAll('-', ' ')}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label="How it was verified"
                    htmlFor="scope-measurement-note"
                    hint="Required human attestation; 10 characters minimum."
                  >
                    <textarea
                      id="scope-measurement-note"
                      value={measurementForm.confirmationNote}
                      maxLength={1_000}
                      onChange={(event) =>
                        setMeasurement({
                          ...measurementForm,
                          confirmationNote: event.target.value,
                        })
                      }
                      placeholder="Measured from the customer’s plan and confirmed by phone."
                    />
                  </Field>
                </div>
                <Button
                  disabled={
                    Boolean(busy) ||
                    !measurementForm.assetId ||
                    !measurementForm.label.trim() ||
                    !measurementForm.value ||
                    !measurementForm.serviceCode ||
                    measurementForm.confirmationNote.trim().length < 10
                  }
                  onClick={confirmMeasurement}
                >
                  {busy === 'measurement' ? 'Confirming…' : 'Create verified measurement'}
                </Button>
              </section>

              <section>
                <div className="scope-photo-panel__subhead">
                  <ShieldAlert size={17} />
                  <div>
                    <h3>Access & risk decision</h3>
                    <p>Record a human disposition without erasing remaining uncertainty.</p>
                  </div>
                </div>
                <div className="form-grid">
                  <Field label="Disposition" htmlFor="scope-review-disposition">
                    <select
                      id="scope-review-disposition"
                      value={reviewForm.disposition}
                      onChange={(event) =>
                        setReview({
                          ...reviewForm,
                          disposition: event.target.value as typeof reviewForm.disposition,
                        })
                      }
                    >
                      <option value="site_verification_required">Site verification required</option>
                      <option value="more_photos_required">More photos required</option>
                      <option value="confirmed_for_estimate">
                        Evidence confirmed for estimate
                      </option>
                    </select>
                  </Field>
                  <Field label="Access decision" htmlFor="scope-access-decision">
                    <textarea
                      id="scope-access-decision"
                      value={reviewForm.accessDecision}
                      maxLength={1_000}
                      onChange={(event) =>
                        setReview({
                          ...reviewForm,
                          accessDecision: event.target.value,
                        })
                      }
                      placeholder="Gate width remains unverified; technician must inspect before setup."
                    />
                  </Field>
                  <Field label="Risk decision" htmlFor="scope-risk-decision">
                    <textarea
                      id="scope-risk-decision"
                      value={reviewForm.riskDecision}
                      maxLength={1_000}
                      onChange={(event) =>
                        setReview({
                          ...reviewForm,
                          riskDecision: event.target.value,
                        })
                      }
                      placeholder="No safety conclusion from photos; pre-work inspection remains required."
                    />
                  </Field>
                  <Field
                    label="Unresolved unknowns"
                    htmlFor="scope-review-unknowns"
                    hint="One per line. Confirmed-for-estimate requires this list to be empty."
                  >
                    <textarea
                      id="scope-review-unknowns"
                      value={reviewForm.unknowns}
                      onChange={(event) =>
                        setReview({ ...reviewForm, unknowns: event.target.value })
                      }
                    />
                  </Field>
                </div>
                <Button
                  variant="secondary"
                  disabled={
                    Boolean(busy) ||
                    reviewForm.accessDecision.trim().length < 10 ||
                    reviewForm.riskDecision.trim().length < 10
                  }
                  onClick={recordReview}
                >
                  {busy === 'review' ? 'Recording…' : 'Record human scope decision'}
                </Button>
              </section>
            </div>
          )}
        </>
      )}

      <p className="scope-photo-panel__retention">
        Registered evidence follows the company operational-retention policy and legal holds.
        Expired unregistered uploads enter the orphan-cleanup queue.
      </p>
      <span className="visually-hidden">Maximum file size {SCOPE_PHOTO_MAX_BYTES} bytes.</span>
    </Card>
  );
}
