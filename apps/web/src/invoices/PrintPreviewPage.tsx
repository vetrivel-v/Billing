import { useQuery } from '@tanstack/react-query';
import {
  buildInvoiceDocument,
  parseInvoiceSnapshot,
  renderInvoiceHtml,
} from '@commercebill/document-engine';
import { Alert, Button, LoadingState, PageHeader } from '@commercebill/ui';
import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ApiError, getInvoice } from '../api.js';
import { useAuth } from '../auth.js';
import { describeFailure } from '../messages.js';
import { useDocumentActions } from './useDocumentActions.js';

/**
 * The print preview: the EXACT document that is printed or saved, built from the posted snapshot read from the API (never from
 * current master data) by the same code the desktop app uses for the PDF. A posted invoice can be previewed any number of times.
 */
export function PrintPreviewPage() {
  const { id } = useParams();
  const { authed } = useAuth();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => authed((token) => getInvoice(token, id!)),
    retry: false,
    staleTime: Infinity,
  });
  const docs = useDocumentActions(q.data?.invoice);
  const rendered = useMemo(() => {
    if (!q.data) return null;
    const parsed = parseInvoiceSnapshot(q.data.invoice);
    return parsed.ok ? renderInvoiceHtml(buildInvoiceDocument(parsed.invoice)) : null;
  }, [q.data]);

  if (q.isPending) return <LoadingState label="Preparing the document" />;
  if (q.isError)
    return (
      <div className="space-y-3">
        <Alert tone="error">
          {q.error instanceof ApiError && q.error.status === 404
            ? 'This invoice could not be found.'
            : describeFailure(q.error)}
        </Alert>
        <Button variant="secondary" onClick={() => navigate('/billing')}>
          Back to invoices
        </Button>
      </div>
    );
  const inv = q.data.invoice;
  return (
    <>
      <PageHeader
        title={`Print preview: ${inv.documentNumber}`}
        description="This is the document exactly as it will print on A4, from the posted invoice."
        actions={
          <>
            <Button
              loading={docs.busy === 'print'}
              disabled={!docs.available || docs.busy !== null}
              title={docs.available ? undefined : docs.unavailableReason}
              onClick={() => void docs.print()}
            >
              Print&hellip;
            </Button>
            <Button
              variant="secondary"
              loading={docs.busy === 'save'}
              disabled={!docs.available || docs.busy !== null}
              title={docs.available ? undefined : docs.unavailableReason}
              onClick={() => void docs.save()}
            >
              Save PDF
            </Button>
            <Button variant="secondary" onClick={() => navigate(`/billing/${inv.id}`)}>
              Back to invoice
            </Button>
          </>
        }
      />
      {!docs.available && (
        <div className="mb-3">
          <Alert tone="info">{docs.unavailableReason}</Alert>
        </div>
      )}
      {docs.message && (
        <div className="mb-3">
          <Alert tone={docs.message.tone}>{docs.message.text}</Alert>
        </div>
      )}
      {rendered === null ? (
        <Alert tone="error">This invoice cannot be shown as a document.</Alert>
      ) : (
        <iframe
          title="Invoice preview"
          sandbox=""
          srcDoc={rendered}
          className="h-[70vh] w-full rounded-lg border border-slate-300 bg-slate-200"
        />
      )}
    </>
  );
}
