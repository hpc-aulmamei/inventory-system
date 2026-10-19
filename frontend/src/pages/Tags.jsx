import { useEffect, useState } from "react";
import Icon from "../components/Icon";
import usePendingAction from "../hooks/usePendingAction";
import { formatDateTime } from "../hooks/dateFormatting";
import { SHEET_PRESETS, labelsPerSheet, openPrintWindow, presetById, printTagSheet } from "../hooks/tagSheets";
import { createTagBatch, deleteTag, getTagBatchForPrinting, getTagBatches } from "../services/api";

const PRESET_KEY = "inventory-tag-sheet";

function savedPresetId() {
  try { return window.localStorage.getItem(PRESET_KEY) || ""; } catch { return ""; }
}

export default function Tags() {
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [presetId, setPresetId] = useState(() => presetById(savedPresetId()).id);
  const preset = presetById(presetId);
  const perSheet = labelsPerSheet(preset);
  const [quantity, setQuantity] = useState(() => String(labelsPerSheet(presetById(savedPresetId()))));
  const [skip, setSkip] = useState("0");
  const [outline, setOutline] = useState(false);
  const [deleteCode, setDeleteCode] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const { busy, beginAction, endAction } = usePendingAction();

  async function loadBatches() {
    setLoading(true);
    try {
      setBatches(await getTagBatches());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { loadBatches(); }, []);

  function choosePreset(id) {
    setPresetId(id);
    setSkip("0");
    try { window.localStorage.setItem(PRESET_KEY, id); } catch {}
  }

  async function run(action) {
    if (!beginAction()) return;
    setError("");
    setMessage("");
    try {
      await action();
    } catch (err) {
      setError(err.message);
    } finally {
      endAction();
    }
  }

  async function printInto(printWindow, tags) {
    try {
      await printTagSheet(printWindow, tags, preset, { skip: Number(skip) || 0, outline });
    } catch (err) {
      printWindow.close();
      throw err;
    }
  }

  function handleCreate(event) {
    event.preventDefault();
    if (busy) return;
    let printWindow;
    try { printWindow = openPrintWindow(); } catch (err) { setError(err.message); return; }
    run(async () => {
      let batch;
      try {
        batch = await createTagBatch(Number(quantity));
      } catch (err) {
        printWindow.close();
        throw err;
      }
      setMessage(`Lotul ${batch.first_code} – ${batch.last_code} a fost generat. Lipește etichetele pe obiecte și scanează-le la „Adaugă obiect”.`);
      setSkip("0");
      loadBatches();
      await printInto(printWindow, batch.tags);
    });
  }

  function handleReprint(batch) {
    if (busy) return;
    let printWindow;
    try { printWindow = openPrintWindow(); } catch (err) { setError(err.message); return; }
    run(async () => {
      let printable;
      try {
        printable = await getTagBatchForPrinting(batch.id);
        if (!printable.tags.length) throw new Error("Lotul nu mai are etichete libere de retipărit.");
      } catch (err) {
        printWindow.close();
        throw err;
      }
      setMessage(`Se retipăresc ${printable.tags.length} etichete libere din lotul #${batch.id}.`);
      await printInto(printWindow, printable.tags);
    });
  }

  function handleDelete(event) {
    event.preventDefault();
    const code = deleteCode.trim().toUpperCase();
    if (!code || busy || !window.confirm(`Ștergi eticheta ${code}? Numărul ei nu va mai fi tipărit.`)) return;
    run(async () => {
      const result = await deleteTag(code);
      setDeleteCode("");
      setMessage(result.message);
      await loadBatches();
    });
  }

  return (
    <section className="page">
      <div className="page-intro">
        <div>
          <span className="page-kicker">ASSET TAGS</span>
          <h2>Etichete</h2>
          <p>Tipărește etichete în avans, lipește una pe obiect, apoi scaneaz-o la „Adaugă obiect”. Așa obiectul intră în inventar.</p>
        </div>
        <div className="count-chip"><strong>{batches.reduce((sum, batch) => sum + batch.available, 0)}</strong><span>libere</span></div>
      </div>

      <div className="split-management">
        <div className="tag-forms">
          <form className="panel compact-form" onSubmit={handleCreate} aria-busy={busy}>
            <div className="panel-header"><div><span className="panel-eyebrow">LOT NOU</span><h3>Tipărește etichete</h3></div><div className="round-icon"><Icon name="printer" size={19} /></div></div>
            <fieldset className="form-fields" disabled={busy}>
              <label className="field"><span>Format coală A4</span>
                <select value={presetId} onChange={(event) => choosePreset(event.target.value)}>
                  {SHEET_PRESETS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              </label>
              <label className="field"><span>Număr de etichete *</span>
                <input type="number" min={1} max={240} required value={quantity} onChange={(event) => setQuantity(event.target.value)} />
                <small>{perSheet} pe coală · maximum 240 într-un lot.</small>
              </label>
              <label className="field"><span>Poziții deja folosite pe prima coală</span>
                <input type="number" min={0} max={perSheet - 1} value={skip} onChange={(event) => setSkip(event.target.value)} />
                <small>Pentru o coală începută: etichetele pornesc după atâtea poziții, de la stânga la dreapta, rând cu rând.</small>
              </label>
              <label className="tag-outline-option"><input type="checkbox" checked={outline} onChange={(event) => setOutline(event.target.checked)} /> Contur de aliniere (test pe hârtie simplă)</label>
            </fieldset>
            <div className="form-actions"><button disabled={busy} className="btn btn-primary" type="submit"><Icon name="printer" size={16} /> Generează și tipărește</button></div>
            <p className="tag-print-hint"><Icon name="alert" size={14} /> În dialogul de tipărire alege scara 100% (dimensiune reală) și margini „Niciuna”, altfel etichetele nu se aliniază cu coala.</p>
          </form>

          <form className="panel compact-form tag-delete-form" onSubmit={handleDelete} aria-busy={busy}>
            <div className="panel-header"><div><span className="panel-eyebrow">ETICHETĂ PIERDUTĂ</span><h3>Șterge o etichetă</h3></div></div>
            <label className="field"><span>Cod etichetă</span>
              <input disabled={busy} maxLength={40} placeholder="INV-000123" value={deleteCode} onChange={(event) => setDeleteCode(event.target.value)} autoCapitalize="characters" spellCheck={false} />
              <small>Pentru etichete libere deteriorate sau pierdute. Eticheta de pe un obiect se înlocuiește din fișa obiectului; cea veche redevine liberă.</small>
            </label>
            <div className="form-actions"><button disabled={busy || !deleteCode.trim()} className="btn btn-secondary" type="submit">Șterge eticheta</button></div>
          </form>

          {message && <div className="alert alert-success" role="status"><Icon name="check" size={17} />{message}</div>}
          {error && <div className="alert alert-error" role="alert"><Icon name="alert" size={17} />{error}</div>}
        </div>

        <div className="table-wrapper" aria-busy={loading}>
          <table>
            <thead><tr><th>Lot</th><th>Generat</th><th>Coduri</th><th>Etichete</th><th>Acțiune</th></tr></thead>
            <tbody>
              {batches.map((batch) => (
                <tr key={batch.id}>
                  <td><strong>#{batch.id}</strong></td>
                  <td>{formatDateTime(batch.created_at, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                  <td className="tag-batch-codes"><code className="code-pill">{batch.first_code}</code> – <code className="code-pill">{batch.last_code}</code></td>
                  <td>
                    <div className="tag-batch-counts">
                      <span><strong>{batch.available}</strong> libere</span>
                      <span><strong>{batch.assigned}</strong> pe obiecte</span>
                      {batch.quantity - batch.available - batch.assigned > 0 && <span><strong>{batch.quantity - batch.available - batch.assigned}</strong> șterse</span>}
                    </div>
                  </td>
                  <td><button type="button" className="btn btn-light tag-reprint" title="Retipărește etichetele libere din acest lot" disabled={busy || !batch.available} onClick={() => handleReprint(batch)}><Icon name="printer" size={15} /> Retipărește</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <p role="status">Se încarcă loturile…</p>}
          {!loading && !batches.length && <div className="empty-state"><div className="empty-icon"><Icon name="tag" size={28} /></div><h3>Niciun lot de etichete</h3><p>Generează primul lot și tipărește-l pe o coală de etichete autoadezive.</p></div>}
        </div>
      </div>
    </section>
  );
}
