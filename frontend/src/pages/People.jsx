import { useEffect, useRef, useState } from "react";
import usePendingAction from "../hooks/usePendingAction";
import useLatestRequest from "../hooks/useLatestRequest";
import useDialogFocus from "../hooks/useDialogFocus";
import Icon from "../components/Icon";
import { createPerson, deactivatePerson, getLoginMethods, getPeople, getDevices, syncPeopleFromDirectory, updatePerson } from "../services/api";

const emptyForm = { name: "", email: "", phone: "", is_responsible: false, is_borrower: true };

const SYNC_SECTIONS = [
  ["created", "Persoane noi"],
  ["linked", "Legate de un cont FreeIPA (aveau același email)"],
  ["updated", "Actualizate"],
  ["reactivated", "Reactivate"],
  ["deactivated", "Dezactivate (cont șters sau dezactivat în FreeIPA)"],
];

function DirectorySyncDialog({ admin, onClose, onSynced }) {
  const ldapAdmin = admin?.method === "ldap";
  const [username, setUsername] = useState(ldapAdmin ? admin.username : "");
  const [password, setPassword] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const { busy, beginAction, endAction } = usePendingAction();
  const dialogRef = useRef(null);
  const passwordRef = useRef(null);
  const close = () => { if (!busy) onClose(); };
  useDialogFocus({ active: true, dialogRef, initialFocusRef: passwordRef, onClose: close });

  async function handleSubmit(event) {
    event.preventDefault();
    if (!password || !username.trim() || !beginAction()) return;
    setError("");
    try {
      const data = await syncPeopleFromDirectory({ username: username.trim(), password });
      setResult(data);
      setPassword("");
      await onSynced();
    } catch (err) {
      setError(err.message);
    } finally {
      endAction();
    }
  }

  return (
    <div className="reset-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div ref={dialogRef} className="reset-modal directory-sync-modal" role="dialog" aria-modal="true" aria-labelledby="directory-sync-title" aria-busy={busy} tabIndex={-1}>
        <div className="reset-modal-icon directory-sync-icon"><Icon name="people" size={24} /></div>
        <span className="panel-eyebrow">FREEIPA</span>
        <h3 id="directory-sync-title">Sincronizează persoanele din FreeIPA</h3>
        {!result ? (
          <form onSubmit={handleSubmit}>
            <ul className="directory-sync-rules">
              <li>Fiecare cont FreeIPA activ devine o persoană care poate împrumuta.</li>
              <li>Membrii grupului de responsabili configurat pe server devin și responsabili.</li>
              <li>Numele și emailul persoanelor din FreeIPA se actualizează; persoanele adăugate manual rămân neschimbate.</li>
              <li>Conturile șterse sau dezactivate în FreeIPA sunt dezactivate aici, mai puțin cele cu împrumuturi active sau obiecte în grijă.</li>
            </ul>
            <label className="field"><span>Utilizator FreeIPA</span>
              <input maxLength={64} autoComplete="username" disabled={busy} value={username} onChange={(event) => setUsername(event.target.value)} autoCapitalize="none" spellCheck={false} required />
            </label>
            <label className="field"><span>Parolă FreeIPA</span>
              <input ref={passwordRef} type="password" autoComplete="current-password" maxLength={256} disabled={busy} value={password} onChange={(event) => setPassword(event.target.value)} required />
              <small>Folosită doar pentru această citire a directorului; nu este salvată.</small>
            </label>
            {error && <div className="alert alert-error" role="alert"><Icon name="alert" size={17} />{error}</div>}
            <div className="reset-actions">
              <button type="button" className="btn btn-secondary" onClick={close} disabled={busy}>Anulează</button>
              <button type="submit" className="btn btn-primary" disabled={busy || !password || !username.trim()}>{busy ? "Se sincronizează…" : "Sincronizează"}</button>
            </div>
          </form>
        ) : (
          <div className="directory-sync-result" role="status">
            <p>{result.directory_people} conturi active citite din FreeIPA{result.responsible_group ? "" : " · niciun grup de responsabili configurat, rolurile de responsabil au rămas neschimbate"}.</p>
            {result.responsible_group && !result.responsible_group_found && <div className="alert alert-error" role="alert"><Icon name="alert" size={17} />Grupul de responsabili configurat nu a fost găsit în FreeIPA: {result.responsible_group}</div>}
            {SYNC_SECTIONS.map(([key, label]) => (
              <details key={key} open={key !== "created" && result[key].length > 0 && result[key].length <= 10}>
                <summary><strong>{result[key].length}</strong> {label}</summary>
                {result[key].length > 0 && <p>{result[key].join(", ")}</p>}
              </details>
            ))}
            {result.skipped.length > 0 && (
              <div className="alert alert-error"><Icon name="alert" size={17} />
                <div><strong>De verificat ({result.skipped.length})</strong>
                  <ul>{result.skipped.map((issue) => <li key={issue.person_id}><strong>{issue.name}</strong>: {issue.reason}</li>)}</ul>
                </div>
              </div>
            )}
            <div className="reset-actions"><button type="button" className="btn btn-primary" onClick={onClose}>Închide</button></div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function People({ admin = null }) {
  const [people, setPeople] = useState([]);
  const [devices, setDevices] = useState([]);
  const [roleFilter, setRoleFilter] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const { busy, beginAction, endAction } = usePendingAction();
  const [loading, setLoading] = useState(true);
  const requests = useLatestRequest();
  const nameRef = useRef(null);
  const [ldapEnabled, setLdapEnabled] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);

  async function loadPeople() {
    const request = requests.begin();
    setLoading(true);
    try {
      const [peopleData, deviceData] = await Promise.all([getPeople(true), getDevices()]);
      if (requests.isCurrent(request)) { setPeople(peopleData); setDevices(deviceData); setError(""); }
    }
    catch (err) { if (requests.isCurrent(request)) setError(err.message); }
    finally { if (requests.isCurrent(request)) setLoading(false); }
  }
  useEffect(() => { loadPeople(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    getLoginMethods(controller.signal).then((methods) => setLdapEnabled(Boolean(methods?.ldap))).catch(() => {});
    return () => controller.abort();
  }, []);

  function startEdit(person) {
    setEditingId(person.id);
    setForm({ name: person.name || "", email: person.email || "", phone: person.phone || "", is_responsible: person.is_responsible, is_borrower: person.is_borrower });
    setMessage("");
    setError("");
    nameRef.current?.focus();
  }
  function cancelEdit() { setEditingId(null); setForm(emptyForm); }

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) return;
    setMessage(""); setError("");
    const payload = { name: form.name.trim(), email: form.email.trim() || null, phone: form.phone.trim() || null, is_responsible: form.is_responsible, is_borrower: form.is_borrower };
    if (!payload.name) { setError("Completează numele persoanei."); return; }
    if (!form.is_responsible && !form.is_borrower) { setError("Selectează cel puțin un rol."); return; }
    if (!beginAction()) return;
    try {
      if (editingId) { await updatePerson(editingId, payload); setMessage("Persoana a fost actualizată."); }
      else { await createPerson(payload); setMessage("Persoana a fost adăugată."); }
      cancelEdit(); await loadPeople();
    } catch (err) { setError(err.message); }
    finally { endAction(); }
  }

  async function toggleActive(person) {
    if (!beginAction()) return;
    setError(""); setMessage("");
    try {
      if (person.active) await deactivatePerson(person.id);
      else await updatePerson(person.id, { active: true });
      await loadPeople();
    } catch (err) { setError(err.message); }
    finally { endAction(); }
  }

  return (
    <section className="page">
      <div className="page-intro">
        <div><span className="page-kicker">PEOPLE DIRECTORY</span><h2>Persoane</h2><p>Responsabilii și destinatarii împrumuturilor, cu datele de contact într-un singur loc.</p></div>
        <div className="people-intro-actions">
          {ldapEnabled && <button type="button" className="btn btn-light" disabled={busy} onClick={() => setSyncOpen(true)}><Icon name="refresh" size={16} /> Sincronizează din FreeIPA</button>}
          <div className="count-chip"><strong>{people.filter((p) => p.active).length}</strong><span>active</span></div>
        </div>
      </div>
      {syncOpen && <DirectorySyncDialog admin={admin} onClose={() => setSyncOpen(false)} onSynced={loadPeople} />}

      <div className="split-management">
        <form className="panel compact-form" onSubmit={handleSubmit} aria-busy={busy}>
          <div className="panel-header"><div><span className="panel-eyebrow">{editingId ? "EDITARE" : "PERSOANĂ NOUĂ"}</span><h3>{editingId ? "Actualizează datele" : "Adaugă persoană"}</h3></div><div className="round-icon"><Icon name="user" size={19} /></div></div>
          {editingId && people.find((p) => p.id === editingId)?.ldap_uid && <p className="directory-linked-note"><Icon name="link" size={15} /> Persoană din FreeIPA: numele, emailul și rolurile se actualizează la următoarea sincronizare.</p>}
          <label className="field"><span>Nume *</span><input ref={nameRef} maxLength={200} autoComplete="name" disabled={busy} name="name" placeholder="Nume complet" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
          <label className="field with-icon"><span>Email</span><div><Icon name="mail" size={17} /><input maxLength={254} autoComplete="email" disabled={busy} name="email" type="email" placeholder="nume@exemplu.ro" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div></label>
          <label className="field with-icon"><span>Telefon</span><div><Icon name="phone" size={17} /><input maxLength={80} type="tel" autoComplete="tel" disabled={busy} name="phone" placeholder="07xx xxx xxx" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div></label>
          <fieldset className="role-options"><legend>Roluri</legend>
            <label><input disabled={busy} type="checkbox" checked={form.is_responsible} onChange={(e) => setForm({ ...form, is_responsible: e.target.checked })} /> Responsabil pentru obiecte</label>
            <label><input disabled={busy} type="checkbox" checked={form.is_borrower} onChange={(e) => setForm({ ...form, is_borrower: e.target.checked })} /> Poate împrumuta obiecte</label>
            <small>Rolurile sunt independente. Poți selecta unul sau ambele.</small>
          </fieldset>
          <div className="form-actions"><button disabled={busy} className="btn btn-primary" type="submit">{editingId ? "Salvează modificările" : "Adaugă persoană"}</button>{editingId && <button disabled={busy} className="btn btn-secondary" type="button" onClick={cancelEdit}>Renunță</button>}</div>
          {message && <div className="alert alert-success" role="status"><Icon name="check" size={17} />{message}</div>}
          {error && <div className="alert alert-error" role="alert"><Icon name="alert" size={17} />{error}<button type="button" className="text-button" disabled={busy || loading} onClick={loadPeople}>Actualizează lista</button></div>}
        </form>

        <div className="table-wrapper management-table" aria-busy={loading}>
          {loading && <p className="management-load-status" role="status">Se încarcă persoanele…</p>}
          <label className="field role-filter"><span>Filtrează după rol</span><select disabled={busy} value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}><option value="">Toate persoanele</option><option value="is_responsible">Responsabili</option><option value="is_borrower">Persoane care împrumută</option></select></label>
          <table>
            <thead><tr><th>Persoană</th><th>Contact</th><th>Roluri / obiecte asociate</th><th>Status</th><th>Acțiuni</th></tr></thead>
            <tbody>
              {people.filter((p) => !roleFilter || p[roleFilter]).map((person) => (
                <tr key={person.id}>
                  <td><div className="object-cell"><div className="object-avatar person-avatar">{(person.name || "?").charAt(0).toUpperCase()}</div><div><strong>{person.name}</strong><span>{person.ldap_uid ? <span className="directory-badge" title="Sincronizat din FreeIPA">FreeIPA · {person.ldap_uid}</span> : `ID #${person.id}`}</span></div></div></td>
                  <td><div className="contact-stack"><span>{person.email || "Fără email"}</span><small>{person.phone || "Fără telefon"}</small></div></td>
                  <td><div className="contact-stack">{person.is_responsible && <strong>Responsabil</strong>}{person.is_borrower && <span>Poate împrumuta</span>}{person.is_responsible && <details><summary>{devices.filter((d) => d.responsible_person_id === person.id).length} obiecte asociate</summary>{devices.filter((d) => d.responsible_person_id === person.id).map((d) => <div key={d.id}>{d.code} · {d.name}</div>)}</details>}</div></td>
                  <td><span className={`badge ${person.active ? "badge-available" : "badge-retired"}`}>{person.active ? "Activ" : "Inactiv"}</span></td>
                  <td><div className="row-actions"><button disabled={busy} className="icon-action" onClick={() => startEdit(person)} title="Editează"><Icon name="edit" size={16} /></button><button disabled={busy} className={`icon-action ${person.active ? "danger" : "success"}`} onClick={() => toggleActive(person)} title={person.active ? "Dezactivează" : "Reactivează"}>{person.active ? <Icon name="trash" size={16} /> : <Icon name="check" size={16} />}</button></div></td>
                </tr>
              ))}
              {!loading && !error && !people.filter((p) => !roleFilter || p[roleFilter]).length && <tr><td colSpan="5"><div className="empty-inline">{roleFilter ? "Nu există persoane cu rolul selectat." : "Nu există persoane înregistrate."}</div></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
