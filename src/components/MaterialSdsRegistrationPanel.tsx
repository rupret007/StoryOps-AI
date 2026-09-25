import { FileCheck2, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { Badge, Button, Card, Field } from '@/components/ui/Primitives';
import { useStoryOps } from '@/state/StoryOpsProvider';

export function MaterialSdsRegistrationPanel() {
  const { state, actions } = useStoryOps();
  const registry = state.materialSdsRegistry;
  const pending = useMemo(
    () =>
      registry?.materials.filter(
        (material) =>
          material.requiresSds && material.registrationStatus === 'registration_required',
      ) ?? [],
    [registry],
  );
  const [selectedKey, setSelectedKey] = useState('');
  const [productName, setProductName] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [revisionDate, setRevisionDate] = useState('');
  const [reviewReference, setReviewReference] = useState('');
  const [file, setFile] = useState<File>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const effectiveKey = pending.some((material) => material.configurationKey === selectedKey)
    ? selectedKey
    : (pending[0]?.configurationKey ?? '');
  const selected = pending.find((material) => material.configurationKey === effectiveKey);

  if (state.dataMode !== 'supabase') {
    return (
      <Card className="section-card material-sds-registry">
        <RegistryHeading />
        <p className="section-card__subtitle">
          Private SDS registration is a live Supabase workflow. Sandbox data cannot claim that a
          safety document was reviewed or stored.
        </p>
      </Card>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    if (!selected || !file) {
      setError('Select an exact configured material and its reviewed PDF.');
      return;
    }
    if (file.type !== 'application/pdf' || file.size < 5 || file.size > 10 * 1024 * 1024) {
      setError('The reviewed SDS must be a PDF between 5 bytes and 10 MB.');
      return;
    }
    setSubmitting(true);
    try {
      const receipt = await actions.registerMaterialSds({
        materialConfigurationKey: selected.configurationKey,
        file,
        productName,
        manufacturer,
        revisionDate,
        reviewReference,
      });
      if (!receipt) {
        setError('The server did not confirm an immutable SDS registration.');
        return;
      }
      setProductName('');
      setManufacturer('');
      setRevisionDate('');
      setReviewReference('');
      setFile(undefined);
      setSelectedKey('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="section-card material-sds-registry">
      <RegistryHeading />
      {!registry ? (
        <div className="incident-empty">
          <LockKeyhole size={22} />
          <div>
            <h3>Save the configuration draft first</h3>
            <p>
              Registration binds the PDF to the server-confirmed configuration revision, material
              key, and expected SHA-256 checksum. Unsaved browser edits are never authority.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="setup-final-note" role="status">
            <ShieldCheck size={17} />
            <span>
              <strong>Exact evidence boundary.</strong> Revision {registry.configurationRevision} is
              identified by {registry.configurationHash.slice(0, 12)}…. The private upload is read
              back byte-for-byte before registration. WashOps does not generate chemical, mixing,
              application, PPE, disposal, or emergency instructions.
            </span>
          </div>
          <div className="material-sds-list" aria-label="Configured material SDS status">
            {registry.materials.map((material) => (
              <div className="template-row" key={material.configurationKey}>
                <span>
                  <strong>{material.name}</strong>
                  <small>
                    {material.configurationKey} · {material.unit}
                    {material.sdsDocument
                      ? ` · immutable SDS v${material.sdsDocument.documentVersion} · revised ${material.sdsDocument.revisionDate}`
                      : material.requiresSds
                        ? ' · exact private PDF required'
                        : ' · non-chemical classification'}
                  </small>
                </span>
                <Badge
                  tone={
                    material.registrationStatus === 'registered'
                      ? 'positive'
                      : material.registrationStatus === 'registration_required'
                        ? 'danger'
                        : 'neutral'
                  }
                >
                  {material.registrationStatus.replaceAll('_', ' ')}
                </Badge>
              </div>
            ))}
          </div>
          {pending.length > 0 && (
            <form className="material-sds-form" onSubmit={(event) => void submit(event)}>
              <Field
                label="Configured material"
                hint={
                  selected?.expectedChecksumSha256
                    ? `Expected SHA-256: ${selected.expectedChecksumSha256}`
                    : undefined
                }
                htmlFor="sds-material"
              >
                <select
                  id="sds-material"
                  className="select"
                  value={effectiveKey}
                  onChange={(event) => setSelectedKey(event.target.value)}
                >
                  {pending.map((material) => (
                    <option value={material.configurationKey} key={material.configurationKey}>
                      {material.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Product name on SDS" htmlFor="sds-product-name">
                <input
                  id="sds-product-name"
                  className="input"
                  minLength={2}
                  maxLength={120}
                  required
                  value={productName}
                  onChange={(event) => setProductName(event.target.value)}
                />
              </Field>
              <Field label="Manufacturer on SDS" htmlFor="sds-manufacturer">
                <input
                  id="sds-manufacturer"
                  className="input"
                  minLength={2}
                  maxLength={120}
                  required
                  value={manufacturer}
                  onChange={(event) => setManufacturer(event.target.value)}
                />
              </Field>
              <Field label="SDS revision date" htmlFor="sds-revision-date">
                <input
                  id="sds-revision-date"
                  className="input"
                  type="date"
                  required
                  value={revisionDate}
                  onChange={(event) => setRevisionDate(event.target.value)}
                />
              </Field>
              <Field
                label="Reviewed private PDF"
                hint="PDF only, up to 10 MB. The file checksum must equal the saved configuration checksum."
                htmlFor="sds-private-pdf"
              >
                <input
                  id="sds-private-pdf"
                  className="input"
                  type="file"
                  accept="application/pdf,.pdf"
                  required
                  onChange={(event) => setFile(event.target.files?.[0])}
                />
              </Field>
              <Field
                label="Owner review reference"
                hint="Use a bounded internal review or ticket reference; do not enter secrets or chemical instructions."
                htmlFor="sds-review-reference"
              >
                <input
                  id="sds-review-reference"
                  className="input"
                  minLength={5}
                  maxLength={240}
                  required
                  value={reviewReference}
                  onChange={(event) => setReviewReference(event.target.value)}
                />
              </Field>
              {error && (
                <p className="setup-error" role="alert">
                  {error}
                </p>
              )}
              <Button
                type="submit"
                icon={<FileCheck2 size={15} />}
                loading={submitting}
                disabled={!state.online || state.role !== 'owner'}
              >
                Verify and register immutable SDS
              </Button>
            </form>
          )}
        </>
      )}
    </Card>
  );
}

function RegistryHeading() {
  return (
    <div className="section-card__header">
      <div>
        <h2>Private material &amp; SDS registry</h2>
        <p className="section-card__subtitle">
          Owner-reviewed evidence; not a source of chemical instructions
        </p>
      </div>
      <LockKeyhole size={18} color="#1f6d5e" />
    </div>
  );
}
