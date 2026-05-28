import { useEffect, useState } from 'react';
import { Briefcase, Plus, MoreHorizontal, FileText, Tags } from 'lucide-react';
import { ActionButton, Avatar, Pill, SectionHeader } from '../primitives';
import { AdminTable } from '../Table';
import { createCliente, updateCliente, listClientes, type Cliente } from '@/services/clientesApi';
import { useToast } from '../Toast';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { X, Loader2, Save } from 'lucide-react';
import { cn } from '@/lib/utils';

export function ClientesSection(): React.ReactElement {
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { notify } = useToast();

  const [editingCliente, setEditingCliente] = useState<Cliente | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listClientes(true);
      setClientes(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      notify({ kind: 'error', text: 'Error cargando clientes', detail: String(err) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = clientes.filter((c) => !c.archived).length;
  const archived = clientes.filter((c) => c.archived).length;

  const handleOpenNew = () => {
    setEditingCliente(null);
    setIsModalOpen(true);
  };

  const handleOpenEdit = (cliente: Cliente) => {
    setEditingCliente(cliente);
    setIsModalOpen(true);
  };

  const handleSaved = () => {
    setIsModalOpen(false);
    notify({ kind: 'success', text: 'Cliente guardado correctamente' });
    void load();
  };

  return (
    <>
      <SectionHeader
        eyebrow="Operación · Clientes"
        actions={
          <ActionButton variant="coral" icon={Plus} onClick={handleOpenNew}>
            Nuevo Cliente
          </ActionButton>
        }
      />

      <div className="mb-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <div className="rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.08] bg-white dark:bg-white/[0.02] p-4">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#0e1745]/55 dark:text-white/55">
            Clientes Activos
          </div>
          <div className="mt-1 font-display text-3xl font-medium tracking-tight text-[#0e1745] dark:text-white">
            {active}
          </div>
        </div>
        <div className="rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.08] bg-white dark:bg-white/[0.02] p-4">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#0e1745]/55 dark:text-white/55">
            Archivados
          </div>
          <div className="mt-1 font-display text-3xl font-medium tracking-tight text-[#0e1745] dark:text-white">
            {archived}
          </div>
        </div>
      </div>

      <AdminTable<Cliente>
        rowKey={(c) => c.id}
        rows={clientes}
        empty={
          loading
            ? <span className="text-[#0e1745]/55 dark:text-white/55">Cargando clientes…</span>
            : error
              ? <span className="text-rose-700 dark:text-rose-300">No se pudo cargar: {error}</span>
              : <span className="text-[#0e1745]/55 dark:text-white/55">No hay clientes registrados.</span>
        }
        columns={[
          {
            header: '',
            cell: (c) => <Avatar initials={c.label.slice(0, 2).toUpperCase()} color="#1534dc" />,
            width: '36px'
          },
          {
            header: 'Cliente',
            cell: (c) => (
              <div className="min-w-0 flex flex-col">
                <span className="font-semibold text-[#0e1745] dark:text-white truncate">{c.label}</span>
                {c.sector && <span className="text-[11.5px] text-[#0e1745]/55 dark:text-white/55 truncate">{c.sector}</span>}
              </div>
            )
          },
          {
            header: 'Contacto',
            cell: (c) => (
              <div className="min-w-0 flex flex-col">
                {c.contact_email && <span className="text-[11.5px] font-mono text-[#0e1745]/70 dark:text-white/70 truncate">{c.contact_email}</span>}
                {c.contact_whatsapp && <span className="text-[11.5px] text-[#0e1745]/55 dark:text-white/55 truncate">{c.contact_whatsapp}</span>}
                {!c.contact_email && !c.contact_whatsapp && <span className="text-[11.5px] text-[#0e1745]/40 dark:text-white/40">Sin contacto</span>}
              </div>
            ),
            width: '180px'
          },
          {
            header: 'Contexto AI',
            cell: (c) => (
              <div className="flex gap-2 items-center">
                {c.context_prompt ? (
                  <span title="Tiene prompt de contexto configurado"><Pill kind="lexa"><FileText size={12} className="mr-1 inline" /> Prompt</Pill></span>
                ) : (
                  <span className="text-[#0e1745]/30 dark:text-white/30 text-[11px]">—</span>
                )}
                {c.context_keywords && c.context_keywords.length > 0 ? (
                  <span title={c.context_keywords.join(', ')}><Pill kind="atlas"><Tags size={12} className="mr-1 inline" /> {c.context_keywords.length}</Pill></span>
                ) : null}
              </div>
            ),
            width: '160px'
          },
          {
            header: 'Estado',
            cell: (c) => c.archived ? <Pill kind="neutral">Archivado</Pill> : <Pill kind="success">Activo</Pill>,
            width: '120px'
          },
          {
            header: '',
            cell: (c) => (
              <ActionButton 
                variant="quiet" 
                icon={MoreHorizontal} 
                onClick={() => handleOpenEdit(c)} 
              />
            ),
            align: 'right',
            width: '60px'
          }
        ]}
      />

      <ClienteModal
        open={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSaved={handleSaved}
        cliente={editingCliente}
      />
    </>
  );
}

function ClienteModal({ open, onClose, onSaved, cliente }: { open: boolean, onClose: () => void, onSaved: () => void, cliente: Cliente | null }) {
  const [label, setLabel] = useState('');
  const [sector, setSector] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactWhatsapp, setContactWhatsapp] = useState('');
  const [description, setDescription] = useState('');
  const [contextPrompt, setContextPrompt] = useState('');
  const [contextKeywords, setContextKeywords] = useState('');
  const [archived, setArchived] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setLabel(cliente?.label ?? '');
      setSector(cliente?.sector ?? '');
      setContactEmail(cliente?.contact_email ?? '');
      setContactWhatsapp(cliente?.contact_whatsapp ?? '');
      setDescription(cliente?.description ?? '');
      setContextPrompt(cliente?.context_prompt ?? '');
      setContextKeywords(cliente?.context_keywords?.join(', ') ?? '');
      setArchived(cliente?.archived ?? false);
      setError(null);
    }
  }, [open, cliente]);

  if (!open) return null;

  const handleSave = async () => {
    if (!label.trim()) {
      setError('El nombre del cliente es obligatorio.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        label: label.trim(),
        sector: sector.trim() || undefined,
        contact_email: contactEmail.trim() || undefined,
        contact_whatsapp: contactWhatsapp.trim() || undefined,
        description: description.trim() || undefined,
        context_prompt: contextPrompt.trim() || undefined,
        context_keywords: contextKeywords.trim() || undefined,
        archived
      };
      if (cliente) {
        await updateCliente(cliente.id, payload);
      } else {
        await createCliente(payload);
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 z-[200] bg-black/55 backdrop-blur-sm"
      />
      <motion.div
        key="dialog"
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.97 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="fixed left-1/2 top-1/2 z-[201] flex flex-col w-[min(92vw,600px)] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-cl2-burgundy/[0.10] dark:border-white/[0.08] bg-white dark:bg-[#231f1f] shadow-[0_30px_80px_rgba(122,59,71,0.28),0_8px_24px_rgba(122,59,71,0.14)]"
      >
        <div className="flex items-center gap-3 px-5 py-4 border-b border-cl2-burgundy/[0.08] dark:border-white/[0.06] shrink-0">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-cl2-burgundy/10 text-cl2-burgundy dark:text-[#d8a4ad]">
            <Briefcase size={16} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="font-display text-[18px] tracking-tight text-[#0e1745] dark:text-white">
              {cliente ? 'Editar Cliente' : 'Nuevo Cliente'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05] text-[#0e1745]/60 dark:text-white/60"
            aria-label="Cerrar"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-5 overflow-y-auto space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 sm:col-span-1">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#0e1745]/55 dark:text-white/55 mb-1">Nombre *</label>
              <input type="text" value={label} onChange={e => setLabel(e.target.value)} placeholder="Ej. FEDEFARMA" className="w-full rounded-md border border-[#0e1745]/[0.10] dark:border-white/[0.10] bg-transparent px-3 py-1.5 text-[13px] text-[#0e1745] dark:text-white focus:border-cl2-burgundy focus:outline-none" />
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#0e1745]/55 dark:text-white/55 mb-1">Sector</label>
              <input type="text" value={sector} onChange={e => setSector(e.target.value)} placeholder="Ej. Salud" className="w-full rounded-md border border-[#0e1745]/[0.10] dark:border-white/[0.10] bg-transparent px-3 py-1.5 text-[13px] text-[#0e1745] dark:text-white focus:border-cl2-burgundy focus:outline-none" />
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#0e1745]/55 dark:text-white/55 mb-1">Contacto Email</label>
              <input type="email" value={contactEmail} onChange={e => setContactEmail(e.target.value)} placeholder="Ej. pm@fedefarma.com" className="w-full rounded-md border border-[#0e1745]/[0.10] dark:border-white/[0.10] bg-transparent px-3 py-1.5 text-[13px] text-[#0e1745] dark:text-white focus:border-cl2-burgundy focus:outline-none" />
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#0e1745]/55 dark:text-white/55 mb-1">Contacto WhatsApp</label>
              <input type="text" value={contactWhatsapp} onChange={e => setContactWhatsapp(e.target.value)} placeholder="Ej. +50688888888" className="w-full rounded-md border border-[#0e1745]/[0.10] dark:border-white/[0.10] bg-transparent px-3 py-1.5 text-[13px] text-[#0e1745] dark:text-white focus:border-cl2-burgundy focus:outline-none" />
            </div>
            <div className="col-span-2">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#0e1745]/55 dark:text-white/55 mb-1">Brief (Descripción Interna)</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} placeholder="Opcional. Notas internas sobre el cliente..." className="w-full rounded-md border border-[#0e1745]/[0.10] dark:border-white/[0.10] bg-transparent px-3 py-1.5 text-[13px] text-[#0e1745] dark:text-white focus:border-cl2-burgundy focus:outline-none resize-y" />
            </div>
          </div>

          <div className="pt-2 border-t border-dashed border-[#0e1745]/10 dark:border-white/10">
            <h4 className="text-[12px] font-semibold text-[#0e1745] dark:text-white mb-3">Inteligencia Artificial (Lexa / Centinela)</h4>
            <div className="space-y-4">
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#0e1745]/55 dark:text-white/55 mb-1">Prompt de Contexto (Lexa)</label>
                <textarea value={contextPrompt} onChange={e => setContextPrompt(e.target.value)} rows={3} placeholder="Instrucciones que se inyectarán a Lexa cuando chatee un usuario de este cliente. Ej: 'Sos el asesor de FEDEFARMA. Tu objetivo es...'" className="w-full rounded-md border border-[#0e1745]/[0.10] dark:border-white/[0.10] bg-transparent px-3 py-1.5 text-[13px] text-[#0e1745] dark:text-white focus:border-cl2-burgundy focus:outline-none resize-y" />
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#0e1745]/55 dark:text-white/55 mb-1">Keywords para Alertas (Separados por coma)</label>
                <input type="text" value={contextKeywords} onChange={e => setContextKeywords(e.target.value)} placeholder="Ej: salud, medicamentos, caja costarricense" className="w-full rounded-md border border-[#0e1745]/[0.10] dark:border-white/[0.10] bg-transparent px-3 py-1.5 text-[13px] text-[#0e1745] dark:text-white focus:border-cl2-burgundy focus:outline-none" />
              </div>
            </div>
          </div>

          {cliente && (
            <div className="pt-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} className="rounded border-gray-300 text-cl2-burgundy focus:ring-cl2-burgundy" />
                <span className="text-[13px] text-[#0e1745] dark:text-white font-medium">Archivar Cliente</span>
              </label>
              <p className="text-[11px] text-[#0e1745]/55 dark:text-white/55 ml-6 mt-0.5">Los clientes archivados no aparecen en los listados activos pero mantienen su historial.</p>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-rose-300/40 bg-rose-50 dark:bg-rose-500/10 dark:border-rose-500/30 px-3 py-2 text-[12.5px] text-rose-700 dark:text-rose-300">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-cl2-burgundy/[0.08] dark:border-white/[0.06] shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-[12.5px] font-medium text-[#0e1745]/65 dark:text-white/65 hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05]"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={saving || !label.trim()}
            onClick={() => void handleSave()}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-cl2-accent hover:bg-cl2-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white text-[12.5px] font-semibold"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {saving ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
}
