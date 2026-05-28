import { useEffect, useState } from 'react';
import { MessageCircle, RefreshCw, Send, AlertTriangle } from 'lucide-react';
import { ActionButton, Pill, SectionHeader } from '../primitives';
import { AdminTable } from '../Table';
import { useToast } from '../Toast';
import { supabase } from '@/lib/supabase';

// Helper inline para auth y fetch, similar a clientesApi.ts pero para /api/admin
async function getAdminAlerts() {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  const res = await fetch('/api/admin/whatsapp-alerts', {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function triggerAdminAlerts() {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  const res = await fetch('/api/admin/whatsapp-alerts/process', {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

interface AlertRow {
  id: string;
  cliente_id: string;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  recipient_phone: string;
  template_name: string;
  created_at: string;
  sent_at: string | null;
  error_msg: string | null;
}

export function WhatsappAlertsSection(): React.ReactElement {
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { notify } = useToast();

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getAdminAlerts();
      setAlerts(data.items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      notify({ kind: 'error', text: 'Error cargando alertas', detail: String(err) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleProcess = async () => {
    setBusy(true);
    try {
      const result = await triggerAdminAlerts();
      notify({ 
        kind: 'success', 
        text: 'Proceso completado', 
        detail: `Procesadas: ${result.processed}, Errores: ${result.errors}` 
      });
      void load();
    } catch (err) {
      notify({ kind: 'error', text: 'Error al procesar alertas', detail: String(err) });
    } finally {
      setBusy(false);
    }
  };

  const pending = alerts.filter(a => a.status === 'pending').length;
  const sent = alerts.filter(a => a.status === 'sent').length;
  const failed = alerts.filter(a => a.status === 'failed' || a.status === 'skipped').length;

  return (
    <>
      <SectionHeader
        eyebrow="Operación · Alertas WhatsApp"
        actions={
          <>
            <ActionButton variant="quiet" icon={RefreshCw} onClick={load} disabled={loading || busy}>
              Refrescar
            </ActionButton>
            <ActionButton variant="coral" icon={Send} onClick={handleProcess} disabled={busy || pending === 0}>
              {busy ? 'Procesando...' : 'Forzar envío'}
            </ActionButton>
          </>
        }
      />

      <div className="mb-5 grid grid-cols-1 gap-3.5 sm:grid-cols-3">
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">
            Pendientes
          </div>
          <div className="mt-1 font-display text-3xl font-medium tracking-tight text-[#0e1745] dark:text-white">
            {pending}
          </div>
        </div>
        <div className="rounded-xl border border-green-500/30 bg-green-500/[0.06] p-4">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-green-700 dark:text-green-300">
            Enviadas
          </div>
          <div className="mt-1 font-display text-3xl font-medium tracking-tight text-[#0e1745] dark:text-white">
            {sent}
          </div>
        </div>
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/[0.06] p-4">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-rose-700 dark:text-rose-300">
            Fallidas / Omitidas
          </div>
          <div className="mt-1 font-display text-3xl font-medium tracking-tight text-[#0e1745] dark:text-white">
            {failed}
          </div>
        </div>
      </div>

      <AdminTable<AlertRow>
        rowKey={(a) => a.id}
        rows={alerts}
        empty={
          loading
            ? <span className="text-[#0e1745]/55 dark:text-white/55">Cargando alertas…</span>
            : error
              ? <span className="text-rose-700 dark:text-rose-300">No se pudo cargar: {error}</span>
              : <span className="text-[#0e1745]/55 dark:text-white/55">No hay alertas registradas.</span>
        }
        columns={[
          {
            header: 'Cliente ID',
            cell: (a) => <span className="font-mono text-[11.5px] text-[#0e1745]/55 dark:text-white/55">{a.cliente_id.split('-')[0]}</span>,
            width: '100px'
          },
          {
            header: 'Teléfono',
            cell: (a) => <span className="font-semibold text-[#0e1745] dark:text-white">{a.recipient_phone}</span>,
            width: '140px'
          },
          {
            header: 'Plantilla',
            cell: (a) => <span className="text-[12.5px] text-[#0e1745]/70 dark:text-white/70">{a.template_name}</span>
          },
          {
            header: 'Creación',
            cell: (a) => <span className="text-[11.5px] text-[#0e1745]/55 dark:text-white/55">{new Date(a.created_at).toLocaleString()}</span>,
            width: '160px'
          },
          {
            header: 'Estado',
            cell: (a) => {
              switch(a.status) {
                case 'pending': return <Pill kind="warn">Pendiente</Pill>;
                case 'sent': return <Pill kind="success">Enviada</Pill>;
                case 'skipped': return <Pill kind="neutral">Omitida</Pill>;
                case 'failed': return <span title={a.error_msg || ''}><Pill kind="danger">Fallida</Pill></span>;
                default: return <Pill kind="neutral">{a.status}</Pill>;
              }
            },
            width: '120px'
          }
        ]}
      />
    </>
  );
}
