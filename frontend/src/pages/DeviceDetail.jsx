import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "../components/Icon";
import AssetImage from "../components/AssetImage";
import useLatestRequest from "../hooks/useLatestRequest";
import usePendingAction from "../hooks/usePendingAction";
import { formatDateTime } from "../hooks/dateFormatting";
import { validateImages } from "../hooks/imageSelection";
import { StatusBadge } from "../components/DeviceTable";
import {
  assignDeviceTag,
  createDevicePublicAccess,
  deleteDeviceImage,
  getDevicePublicAccess,
  getDeviceTracking,
  getLocations,
  getPeople,
  getLoans,
  mediaUrl,
  regenerateDevicePublicAccess,
  revokeDevicePublicAccess,
  updateDevice,
  uploadDeviceImages,
} from "../services/api";


function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Statuses an admin can set here; LOANED is set by Loans only.
const EDITABLE_STATUSES = [
  ["AVAILABLE", "Disponibil"],
  ["IN_USE", "În uz"],
  ["BROKEN", "Stricat"],
  ["LOST", "Pierdut"],
  ["RETIRED", "Scos din uz"],
];

function detailsForm(device) {
  return {
    name: device.name || "",
    category: device.category || "",
    serial_number: device.serial_number || "",
    description: device.description || "",
    status: device.status,
  };
}

function formatDate(value) {
  return formatDateTime(value, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function DeviceDetail({ deviceId, onBack, onChanged }) {
  const [tracking, setTracking] = useState(null);
  const [locations, setLocations] = useState([]);
  const [people, setPeople] = useState([]);
  const [responsibleId, setResponsibleId] = useState("");
  const [currentLoan, setCurrentLoan] = useState(null);
  const [locationId, setLocationId] = useState("");
  const [loading, setLoading] = useState(true);
  const [publicAccess, setPublicAccess] = useState(null);
  const [newTag, setNewTag] = useState("");
  const [details, setDetails] = useState(null);
  const [actionKind, setActionKind] = useState("");
  const { busy, beginAction, endAction } = usePendingAction();
  const savingResponsible = actionKind === "responsible";
  const savingLocation = actionKind === "location";
  const uploading = actionKind === "upload";
  const publicAccessBusy = actionKind === "qr";
  const [publicBaseUrl, setPublicBaseUrl] = useState(() => window.location.origin);
  const lastQrBaseUrl = useRef(window.location.origin);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const requests = useLatestRequest();
  const currentDevice = useRef(deviceId);
  currentDevice.current = deviceId;
  const qrImageSource = publicAccess?.qr_svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(publicAccess.qr_svg)}` : "";

  async function load() {
    const request = requests.begin();
    const requestedDevice = deviceId;
    setLoading(true);
    try {
      const [trackingData, locationData, accessData, peopleData, loansData] = await Promise.all([
        getDeviceTracking(deviceId),
        getLocations(true),
        getDevicePublicAccess(deviceId, lastQrBaseUrl.current).catch((err) => {
          if (err.status === 404) return null;
          throw err;
        }),
        getPeople(true),
        getLoans("ACTIVE"),
      ]);
      if (!requests.isCurrent(request) || requestedDevice !== currentDevice.current) return;
      setPeople(peopleData);
      setCurrentLoan(loansData.find((loan) => loan.device_id === Number(deviceId)) || null);
      setResponsibleId(String(trackingData.device.responsible_person_id || ""));
      setTracking(trackingData);
      setLocations((locationData || []).filter((location) => location.active !== false || location.id === trackingData.device.location_id));
      setLocationId(String(trackingData.device.location_id || ""));
      setPublicAccess(accessData);
      setError("");
    } catch (err) {
      if (requests.isCurrent(request) && requestedDevice === currentDevice.current) setError(err.message);
    } finally {
      if (requests.isCurrent(request) && requestedDevice === currentDevice.current) setLoading(false);
    }
  }

  useEffect(() => {
    currentDevice.current = deviceId;
    setTracking(null);
    setPublicAccess(null);
    setDetails(null);
    setMessage("");
    setError("");
    load();
    return () => { currentDevice.current = null; };
  }, [deviceId]);

  const sortedHistory = useMemo(
    () => [...(tracking?.location_history || [])].sort((a, b) => new Date(b.changed_at) - new Date(a.changed_at)),
    [tracking]
  );

  async function runAction(kind, action) {
    if (loading || !beginAction()) return;
    const requestedDevice = deviceId;
    setActionKind(kind);
    setError("");
    setMessage("");
    try {
      await action(() => requestedDevice === currentDevice.current);
    } catch (err) {
      if (requestedDevice === currentDevice.current) setError(err.message);
    } finally {
      setActionKind("");
      endAction();
    }
  }

  function normalizedBaseUrl() {
    try {
      const url = new URL(publicBaseUrl.trim());
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      const result = url.href.replace(/\/$/, "");
      lastQrBaseUrl.current = result;
      return result;
    } catch {
      throw new Error("Introdu o adresă HTTP sau HTTPS validă, fără parolă, parametri sau fragment.");
    }
  }

  async function handleResponsibleChange() {
    await runAction("responsible", async (isCurrent) => {
      await updateDevice(deviceId, { responsible_person_id: responsibleId ? Number(responsibleId) : null });
      if (!isCurrent()) return;
      await load(); await onChanged?.();
      if (isCurrent()) setMessage("Responsabilul obiectului a fost actualizat.");
    });
  }

  function startEditingDetails() {
    setDetails(detailsForm(tracking.device));
    setMessage("");
    setError("");
  }

  async function handleSaveDetails(event) {
    event.preventDefault();
    if (!details || busy || loading) return;
    const name = details.name.trim();
    const category = details.category.trim();
    if (!name || !category) {
      setError("Numele și categoria sunt obligatorii.");
      return;
    }
    const loaned = tracking.device.status === "LOANED";
    await runAction("details", async (isCurrent) => {
      await updateDevice(deviceId, {
        name,
        category,
        serial_number: details.serial_number.trim() || null,
        description: details.description.trim() || null,
        // While on loan the status belongs to the loan; send it only otherwise.
        ...(loaned ? {} : { status: details.status }),
      });
      if (!isCurrent()) return;
      setDetails(null);
      await load();
      await onChanged?.();
      if (isCurrent()) setMessage("Datele obiectului au fost actualizate.");
    });
  }

  async function handleAssignTag(event) {
    event.preventDefault();
    const code = newTag.trim().toUpperCase();
    const current = tracking?.device.tag_code;
    if (!code || busy || loading) return;
    if (current && !window.confirm(`Înlocuiești eticheta ${current} cu ${code}? ${current} redevine liberă și poate fi pusă pe alt obiect.`)) return;
    await runAction("tag", async (isCurrent) => {
      await assignDeviceTag(deviceId, code);
      if (!isCurrent()) return;
      setNewTag("");
      await load();
      await onChanged?.();
      if (isCurrent()) setMessage(current ? `Eticheta a fost înlocuită cu ${code}.` : `Eticheta ${code} a fost asociată obiectului.`);
    });
  }

  async function handleLocationChange() {
    if (!locationId) return;
    await runAction("location", async (isCurrent) => {
      await updateDevice(deviceId, { location_id: Number(locationId) });
      if (!isCurrent()) return;
      await load();
      await onChanged?.();
      if (isCurrent()) setMessage("Locația a fost actualizată și mutarea a fost adăugată în istoric.");
    });
  }

  async function handleUpload(event) {
    const selection = validateImages(Array.from(event.target.files || []));
    event.target.value = "";
    if (selection.error) { setError(selection.error); return; }
    if (!selection.files.length) return;
    await runAction("upload", async (isCurrent) => {
      const uploaded = await uploadDeviceImages(deviceId, selection.files);
      if (!isCurrent()) return;
      await load();
      await onChanged?.();
      if (isCurrent()) setMessage(`${uploaded.length} ${uploaded.length === 1 ? "imagine a fost încărcată" : "imagini au fost încărcate"}.`);
    });
  }

  async function handleDeleteImage(imageId) {
    if (busy || loading || !window.confirm("Ștergi această imagine din fișa obiectului?")) return;
    await runAction("delete-image", async (isCurrent) => {
      await deleteDeviceImage(deviceId, imageId);
      if (!isCurrent()) return;
      await load();
      await onChanged?.();
      if (isCurrent()) setMessage("Imaginea a fost ștearsă.");
    });
  }

  async function handleGeneratePublicAccess() {
    await runAction("qr", async (isCurrent) => {
      const access = await createDevicePublicAccess(deviceId, normalizedBaseUrl());
      if (!isCurrent()) return;
      setPublicAccess(access);
      setMessage("Pagina de utilizator și codul QR sunt active.");
    });
  }

  async function handleRefreshPublicAddress() {
    if (!publicAccess) return;
    await runAction("qr", async (isCurrent) => {
      const access = await getDevicePublicAccess(deviceId, normalizedBaseUrl());
      if (!isCurrent()) return;
      setPublicAccess(access);
      setMessage("QR-ul folosește acum adresa introdusă. Tokenul obiectului nu a fost schimbat.");
    });
  }

  async function handleRegeneratePublicAccess() {
    if (busy || loading || !window.confirm("Regenerarea invalidează imediat codul QR și linkul vechi. Continui?")) return;
    await runAction("qr", async (isCurrent) => {
      const access = await regenerateDevicePublicAccess(deviceId, normalizedBaseUrl());
      if (!isCurrent()) return;
      setPublicAccess(access);
      setMessage("Codul QR a fost regenerat. Etichetele vechi nu mai deschid obiectul.");
    });
  }

  async function handleRevokePublicAccess() {
    if (busy || loading || !window.confirm("Dezactivezi pagina de utilizator? QR-ul tipărit nu va mai funcționa până generezi unul nou.")) return;
    await runAction("qr", async (isCurrent) => {
      await revokeDevicePublicAccess(deviceId);
      if (!isCurrent()) return;
      setPublicAccess(null);
      setMessage("Accesul prin QR a fost dezactivat.");
    });
  }

  async function handleCopyPublicUrl() {
    if (!publicAccess?.public_url) return;
    try {
      await navigator.clipboard.writeText(publicAccess.public_url);
      setMessage("Linkul public a fost copiat.");
    } catch {
      window.prompt("Copiază linkul:", publicAccess.public_url);
    }
  }

  function handleDownloadQr() {
    if (!publicAccess?.qr_svg) return;
    const blob = new Blob([publicAccess.qr_svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${tracking.device.code}-qr.svg`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function handlePrintLabel() {
    if (!publicAccess?.qr_svg || !tracking) return;
    const { device, current_location: currentLocation } = tracking;
    const printWindow = window.open("", "_blank", "width=700,height=520");
    if (!printWindow) {
      setError("Browserul a blocat fereastra de print. Permite pop-up-uri pentru această pagină și încearcă din nou.");
      return;
    }

    printWindow.opener = null;
    printWindow.document.write(`<!doctype html>
<html lang="ro">
<head>
<meta charset="utf-8" />
<title>Etichetă ${escapeHtml(device.code)}</title>
<style>
  @page { size: 70mm 40mm; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Inter, Arial, sans-serif; color: #0e2828; background: white; }
  .label { width: 70mm; height: 40mm; padding: 4mm; display: grid; grid-template-columns: 26mm 1fr; gap: 4mm; border: .35mm solid #00868b; overflow: hidden; }
  .qr { width: 26mm; height: 26mm; display: grid; place-items: center; align-self: center; }
  .qr img { display: block; width: 100%; height: 100%; }
  .data { min-width: 0; display: flex; flex-direction: column; justify-content: center; }
  .brand { color: #00868b; font-size: 7pt; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 1.4mm; }
  .code { font: 800 12pt ui-monospace, SFMono-Regular, Consolas, monospace; margin-bottom: 1.2mm; }
  .name { font-size: 9.5pt; line-height: 1.15; font-weight: 800; margin-bottom: 1.5mm; overflow: hidden; }
  .meta { font-size: 7pt; line-height: 1.35; color: #496262; }
  .scan { margin-top: 2mm; font-size: 6.5pt; color: #00868b; font-weight: 700; }
</style>
</head>
<body>
  <div class="label">
    <div class="qr"><img src="${escapeHtml(qrImageSource)}" alt="Cod QR" /></div>
    <div class="data">
      <div class="brand">Inventar · Asset tracking</div>
      <div class="code">${escapeHtml(device.code)}</div>
      <div class="name">${escapeHtml(device.name)}</div>
      <div class="meta">${escapeHtml(device.category)}<br />📍 ${escapeHtml(currentLocation?.name || "Locație nespecificată")}</div>
      <div class="scan">Scanează pentru fișa obiectului</div>
    </div>
  </div>
</body>
</html>`);
    printWindow.document.close();
    const image = printWindow.document.querySelector("img");
    const print = () => {
      if (printWindow.closed) return;
      printWindow.focus();
      printWindow.print();
    };
    if (image.complete && image.naturalWidth) printWindow.setTimeout(print, 100);
    else image.addEventListener("load", print, { once: true });
    image.addEventListener("error", () => {
      setError("Codul QR nu a putut fi încărcat pentru tipărire. Încearcă din nou.");
      printWindow.close();
    }, { once: true });
  }

  if ((loading && !tracking) || (tracking && tracking.device.id !== Number(deviceId))) {
    return (
      <section className="page">
        <div className="detail-loading panel" role="status"><Icon name="refresh" size={22} /><span>Se încarcă fișa obiectului...</span></div>
      </section>
    );
  }

  if (!tracking) {
    return (
      <section className="page">
        <button className="back-link" type="button" onClick={onBack}><Icon name="back" size={16} /> Înapoi la inventar</button>
        <div className="alert alert-error" role="alert"><Icon name="alert" size={18} /><span>{error || "Obiectul nu a putut fi încărcat."}</span></div>
        <button type="button" className="btn btn-secondary" onClick={load}>Reîncearcă</button>
      </section>
    );
  }

  const { device, current_location: currentLocation, images = [] } = tracking;
  const selectedLocationChanged = String(device.location_id || "") !== String(locationId || "");

  return (
    <section className="page device-detail-page" aria-busy={loading || busy}>
      <button className="back-link" type="button" disabled={busy} onClick={onBack}><Icon name="back" size={16} /> Înapoi la inventar</button>

      <div className="device-detail-hero">
        <div className="detail-identity">
          <div className="detail-mark"><Icon name="inventory" size={28} /></div>
          <div>
            <div className="detail-kicker"><code>{device.code}</code><StatusBadge status={device.status} /></div>
            <h2>{device.name}</h2>
            <p>{device.description || "Fără descriere pentru acest obiect."}</p>
          </div>
        </div>
        <div className="detail-current-location">
          <span>LOCAȚIE CURENTĂ</span>
          <strong><Icon name="pin" size={18} /> {currentLocation?.name || "Nesetată"}</strong>
          <small>{currentLocation?.description || "Poți schimba locația din panoul de tracking."}</small>
        </div>
      </div>

      {message && <div className="alert alert-success" role="status"><Icon name="check" size={18} /><span>{message}</span></div>}
      {error && <div className="alert alert-error" role="alert"><Icon name="alert" size={18} /><span>{error}</span></div>}
      {loading && <p className="detail-refresh-status" role="status">Se actualizează fișa…</p>}

      <div className="detail-grid">
        <div className="detail-main-column">
          <div className="panel tracking-panel">
            <div className="panel-header"><h3>Responsabil obiect</h3></div>
            <p>Responsabil actual: <strong>{people.find((p) => p.id === device.responsible_person_id)?.name || "Fără responsabil"}</strong></p>
            <p>Împrumutat către: <strong>{currentLoan?.person_name || "Nu există un împrumut activ"}</strong></p>
            <div className="location-editor">
              <label className="field"><span>Asociază o persoană responsabilă</span><select disabled={busy || loading} value={responsibleId} onChange={(e) => setResponsibleId(e.target.value)}><option value="">Fără responsabil</option>{people.filter((p) => (p.active && p.is_responsible) || p.id === device.responsible_person_id).map((p) => <option key={p.id} value={p.id} disabled={!p.active || !p.is_responsible}>{p.name}{!p.active ? " (inactiv)" : ""}</option>)}</select></label>
              <button type="button" className="btn btn-primary" disabled={busy || loading || responsibleId === String(device.responsible_person_id || "")} onClick={handleResponsibleChange}>{savingResponsible ? "Se salvează..." : "Salvează responsabilul"}</button>
            </div>
            <p className="location-editor-note">Împrumutarea și returnarea păstrează responsabilul. Schimbarea este înregistrată în jurnal.</p>
          </div>
          <div className="panel tracking-panel">
            <div className="panel-header">
              <div><span className="panel-eyebrow">LOCATION TRACKING</span><h3>Mută obiectul</h3></div>
              <div className="tracking-live"><Icon name="history" size={14} /> istoric salvat</div>
            </div>

            <div className="location-editor">
              <div className="location-editor-icon"><Icon name="pin" size={22} /></div>
              <label className="field">
                <span>Noua locație</span>
                <select disabled={busy || loading} value={locationId} onChange={(event) => setLocationId(event.target.value)}>
                  <option value="">Selectează locația...</option>
                  {locations.map((location) => <option key={location.id} value={location.id} disabled={location.active === false}>{location.name}{location.active === false ? " (inactivă)" : ""}</option>)}
                </select>
              </label>
              <button className="btn btn-primary" type="button" disabled={!selectedLocationChanged || busy || loading || !locationId} onClick={handleLocationChange}>
                <Icon name="pin" size={16} /> {savingLocation ? "Se mută..." : "Confirmă mutarea"}
              </button>
            </div>
            <p className="location-editor-note">Fiecare schimbare este salvată separat, cu locația veche, locația nouă și momentul mutării.</p>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div><span className="panel-eyebrow">PHOTO RECORD</span><h3>Fotografii obiect</h3></div>
              <label className={`btn btn-light upload-button ${uploading ? "disabled" : ""}`}>
                <Icon name="upload" size={16} /> {uploading ? "Se încarcă..." : "Adaugă imagini"}
                <input type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={handleUpload} disabled={busy || loading} />
              </label>
            </div>

            {images.length ? (
              <div className="device-gallery">
                {images.map((image) => (
                  <article className="device-photo" key={image.id}>
                    <a href={mediaUrl(image.url)} target="_blank" rel="noreferrer">
                      <AssetImage src={image.url} name={image.original_name} lazy />
                    </a>
                    <div className="device-photo-meta">
                      <div><strong>{image.original_name}</strong><span>{formatDate(image.uploaded_at)}</span></div>
                      <button type="button" disabled={busy || loading} className="icon-action danger" onClick={() => handleDeleteImage(image.id)} title="Șterge imaginea" aria-label={`Șterge fotografia ${image.original_name}`}><Icon name="trash" size={15} /></button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <label className="image-empty-state">
                <input type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={handleUpload} disabled={busy || loading} />
                <span><Icon name="image" size={25} /></span>
                <strong>Nu există încă fotografii</strong>
                <small>Încarcă imagini reale ale obiectului pentru identificare rapidă.</small>
              </label>
            )}
          </div>

          <div className="panel">
            <div className="panel-header">
              <div><span className="panel-eyebrow">LOCATION HISTORY</span><h3>Istoric locații</h3></div>
              <span className="history-count">{sortedHistory.length} evenimente</span>
            </div>

            {sortedHistory.length ? (
              <div className="tracking-timeline">
                {sortedHistory.map((entry, index) => (
                  <div className="timeline-entry" key={entry.id}>
                    <div className="timeline-rail"><span className={index === 0 ? "current" : ""} />{index !== sortedHistory.length - 1 && <i />}</div>
                    <div className="timeline-card">
                      <div className="timeline-title">
                        <strong>{["INITIAL_ASSIGNMENT", "LEGACY_SNAPSHOT"].includes(entry.change_type) ? "Locație inițială" : "Obiect mutat"}</strong>
                        <time>{formatDate(entry.changed_at)}</time>
                      </div>
                      <div className="timeline-route">
                        {entry.from_location_name && <><span>{entry.from_location_name}</span><Icon name="arrow" size={15} /></>}
                        <strong><Icon name="pin" size={14} /> {entry.to_location_name}</strong>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-inline">Nu există încă mutări înregistrate pentru acest obiect.</div>
            )}
          </div>
        </div>

        <aside className="detail-side-column">
          <div className="panel detail-facts">
            <div className="panel-header">
              <div><span className="panel-eyebrow">ASSET DATA</span><h3>Fișa tehnică</h3></div>
              {!details && <button type="button" className="btn btn-light detail-edit-button" disabled={busy || loading} onClick={startEditingDetails}><Icon name="edit" size={15} /> Editează</button>}
            </div>
            {details ? (
              <form className="detail-edit-form" onSubmit={handleSaveDetails} aria-busy={actionKind === "details"}>
                <fieldset className="form-fields" disabled={busy || loading}>
                  <label className="field"><span>Nume obiect *</span><input name="name" maxLength={200} required value={details.name} onChange={(event) => setDetails({ ...details, name: event.target.value })} /></label>
                  <label className="field"><span>Categorie *</span><input name="category" maxLength={200} required value={details.category} onChange={(event) => setDetails({ ...details, category: event.target.value })} /></label>
                  <label className="field"><span>Număr de serie</span><input name="serial_number" maxLength={255} value={details.serial_number} onChange={(event) => setDetails({ ...details, serial_number: event.target.value })} /></label>
                  <label className="field"><span>Status</span>
                    {device.status === "LOANED" ? (
                      <>
                        <select disabled value="LOANED"><option value="LOANED">Împrumutat</option></select>
                        <small>Obiectul este împrumutat; statusul se schimbă la returnare, din Împrumuturi.</small>
                      </>
                    ) : (
                      <select name="status" value={details.status} onChange={(event) => setDetails({ ...details, status: event.target.value })}>
                        {EDITABLE_STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    )}
                  </label>
                  <label className="field"><span>Descriere</span><textarea name="description" maxLength={10000} className="small-textarea" value={details.description} onChange={(event) => setDetails({ ...details, description: event.target.value })} /></label>
                </fieldset>
                <div className="form-actions">
                  <button type="submit" className="btn btn-primary" disabled={busy || loading}>{actionKind === "details" ? "Se salvează…" : "Salvează"}</button>
                  <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setDetails(null)}>Renunță</button>
                </div>
              </form>
            ) : (
            <dl>
              <div><dt>Cod inventar</dt><dd><code className="code-pill">{device.code}</code></dd></div>
              <div><dt>Etichetă</dt><dd>{device.tag_code ? <code className="code-pill">{device.tag_code}</code> : "Fără etichetă"}</dd></div>
              <div><dt>Categorie</dt><dd>{device.category}</dd></div>
              <div><dt>Număr serie</dt><dd>{device.serial_number || "-"}</dd></div>
              <div><dt>Status</dt><dd><StatusBadge status={device.status} /></dd></div>
              <div><dt>ID intern</dt><dd>#{device.id}</dd></div>
            </dl>
            )}
          </div>

          <form className="panel tag-panel" onSubmit={handleAssignTag} aria-busy={actionKind === "tag"}>
            <div className="panel-header">
              <div><span className="panel-eyebrow">ASSET TAG</span><h3>Etichetă</h3></div>
              <div className="round-icon"><Icon name="tag" size={18} /></div>
            </div>
            <div className={`tag-current ${device.tag_code ? "" : "missing"}`}>
              <Icon name="barcode" size={18} />
              <strong>{device.tag_code || "Fără etichetă"}</strong>
            </div>
            <label className="field">
              <span>{device.tag_code ? "Înlocuiește cu eticheta" : "Asociază eticheta"}</span>
              <input disabled={busy || loading} maxLength={40} placeholder="Scanează eticheta (INV-000123)" value={newTag} onChange={(event) => setNewTag(event.target.value)} autoCapitalize="characters" spellCheck={false} />
            </label>
            <div className="tag-panel-actions">
              <button className="btn btn-primary" type="submit" disabled={busy || loading || !newTag.trim()}><Icon name="tag" size={15} /> {device.tag_code ? "Înlocuiește" : "Asociază"}</button>
            </div>
          </form>

          <div className="panel public-access-panel">
            <div className="panel-header public-access-heading">
              <div><span className="panel-eyebrow">USER ACCESS</span><h3>QR & etichetă</h3></div>
              <span className={`access-dot ${publicAccess ? "active" : ""}`} title={publicAccess ? "Link activ" : "Link inactiv"} />
            </div>

            <label className="public-base-url-field">
              <span>Adresa folosită în QR</span>
              <input type="url" disabled={busy || loading} maxLength={500} value={publicBaseUrl} onChange={(event) => setPublicBaseUrl(event.target.value)} placeholder="https://inventar.exemplu.ro" />
              <small>Pentru scanare de pe telefon în testare, folosește IP-ul PC-ului, nu localhost.</small>
            </label>

            {!publicAccess ? (
              <div className="public-access-empty">
                <span className="qr-placeholder"><Icon name="qr" size={34} /></span>
                <strong>Fișă read-only pentru utilizator</strong>
                <p>Generează un link greu de ghicit care poate fi pus pe obiect sub formă de QR sau etichetă.</p>
                <button className="btn btn-primary btn-block" type="button" disabled={busy || loading} onClick={handleGeneratePublicAccess}>
                  <Icon name="qr" size={16} /> {publicAccessBusy ? "Se generează..." : "Generează QR"}
                </button>
              </div>
            ) : (
              <div className="public-access-ready">
                <div className="qr-preview"><img src={qrImageSource} alt={`Cod QR pentru ${device.name}`} width={152} height={152} /></div>
                <div className="public-link-box">
                  <span>Link utilizator</span>
                  <strong title={publicAccess.public_url}>{publicAccess.public_url}</strong>
                </div>

                <div className="public-access-actions">
                  <button className="btn btn-primary" type="button" disabled={busy || loading} onClick={handlePrintLabel}><Icon name="printer" size={15} /> Tipărește eticheta</button>
                  <button className="btn btn-light" type="button" disabled={busy || loading} onClick={() => { try { const url = new URL(publicAccess.public_url); if (!["http:", "https:"].includes(url.protocol)) throw new Error(); window.open(url.href, "_blank", "noopener,noreferrer"); } catch { setError("Linkul public nu este o adresă HTTP sau HTTPS validă."); } }}><Icon name="external" size={15} /> Vezi ca user</button>
                  <button className="btn btn-light" type="button" disabled={busy || loading} onClick={handleCopyPublicUrl}><Icon name="copy" size={15} /> Copiază</button>
                  <button className="btn btn-light" type="button" disabled={busy || loading} onClick={handleRefreshPublicAddress}><Icon name="refresh" size={15} /> Actualizează QR</button>
                  <button className="btn btn-light" type="button" disabled={busy || loading} onClick={handleDownloadQr}><Icon name="download" size={15} /> QR SVG</button>
                </div>

                <div className="public-access-security">
                  <Icon name="shield" size={16} />
                  <span>Linkul oferă numai vizualizare. Nu expune persoane, împrumuturi, loguri sau controale de admin.</span>
                </div>

                <div className="public-access-danger-actions">
                  <button type="button" disabled={busy || loading} onClick={handleRegeneratePublicAccess}>Regenerează linkul</button>
                  <button type="button" className="danger" disabled={busy || loading} onClick={handleRevokePublicAccess}>Dezactivează</button>
                </div>
              </div>
            )}
          </div>

          <div className="aside-card dark-card tracking-help-card">
            <div className="aside-icon"><Icon name="history" /></div>
            <h3>Urme permanente</h3>
            <p>Schimbarea locației nu suprascrie trecutul. Istoricul rămâne disponibil chiar dacă locația este redenumită ulterior.</p>
          </div>
        </aside>
      </div>
    </section>
  );
}
