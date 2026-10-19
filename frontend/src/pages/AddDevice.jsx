import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Icon from "../components/Icon";
import usePendingAction from "../hooks/usePendingAction";
import useLatestRequest from "../hooks/useLatestRequest";
import { validateImages } from "../hooks/imageSelection";
import { createDevice, getPeople, getLocations, getTag, uploadDeviceImages } from "../services/api";

const initialForm = {
  name: "",
  category: "",
  status: "AVAILABLE",
  serial_number: "",
  description: "",
  location_id: "",
  responsible_person_id: "",
};

function tagProblem(tag) {
  if (tag.status === "ASSIGNED") return `Eticheta ${tag.code} este deja pe ${tag.device ? `${tag.device.code} · ${tag.device.name}` : "alt obiect"}.`;
  return "";
}

export default function AddDevice({ initialTag = "", onDeviceAdded, onNavigate, onOpenDevice }) {
  const [form, setForm] = useState(initialForm);
  const [tagCode, setTagCode] = useState(initialTag);
  const [tagCheck, setTagCheck] = useState({ state: "idle", text: "" });
  const [created, setCreated] = useState(null);
  const tagRef = useRef(null);
  const nameRef = useRef(null);
  const initialFocusDone = useRef(false);
  const focusTagAfterSave = useRef(false);
  const [locations, setLocations] = useState([]);
  const [responsibles, setResponsibles] = useState([]);
  const [images, setImages] = useState([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [previews, setPreviews] = useState([]);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [optionsError, setOptionsError] = useState("");
  const [locationsLoaded, setLocationsLoaded] = useState(false);
  const { busy: saving, beginAction, endAction } = usePendingAction();
  const requests = useLatestRequest();

  async function loadOptions() {
    const request = requests.begin();
    setLoadingOptions(true);
    setOptionsError("");
    const [people, locations] = await Promise.allSettled([getPeople(false, "responsible"), getLocations(true)]);
    if (!requests.isCurrent(request)) return;
    if (people.status === "fulfilled") setResponsibles(people.value);
    if (locations.status === "fulfilled") {
      setLocations((locations.value || []).filter((location) => location.active !== false));
      setLocationsLoaded(true);
    }
    setOptionsError([people, locations].filter(result => result.status === "rejected").map(result => result.reason.message).join(" "));
    setLoadingOptions(false);
  }
  useEffect(() => { loadOptions(); }, []);

  useEffect(() => { if (initialTag) checkTag(initialTag); }, []);

  // The fields are disabled while loading or saving and cannot take focus
  // until then. On desktops the tag field waits for the scanner; phones
  // would open the on-screen keyboard instead.
  useEffect(() => {
    if (loadingOptions || saving) return;
    if (!initialFocusDone.current) {
      initialFocusDone.current = true;
      if (initialTag) nameRef.current?.focus();
      else if (window.matchMedia?.("(pointer: fine)").matches) tagRef.current?.focus();
    } else if (focusTagAfterSave.current) {
      focusTagAfterSave.current = false;
      tagRef.current?.focus();
    }
  }, [loadingOptions, saving]);

  async function checkTag(value) {
    const code = value.trim().toUpperCase();
    if (!code) {
      setTagCheck({ state: "idle", text: "" });
      return true;
    }
    setTagCheck({ state: "checking", text: "Se verifică eticheta…" });
    try {
      const tag = await getTag(code);
      const problem = tagProblem(tag);
      setTagCheck(problem ? { state: "error", text: problem } : { state: "ok", text: `Eticheta ${tag.code} este liberă și va fi asociată la salvare.` });
      return !problem;
    } catch (err) {
      setTagCheck({ state: "error", text: err.message });
      return false;
    }
  }

  function handleTagKey(event) {
    if (event.key !== "Enter") return;
    // Scanners finish with Enter: check the tag instead of submitting the form.
    event.preventDefault();
    checkTag(tagCode).then((usable) => { if (usable && tagCode.trim()) nameRef.current?.focus(); });
  }

  useLayoutEffect(() => {
    const current = images.map((file) => ({ file, url: URL.createObjectURL(file) }));
    setPreviews(current);
    return () => current.forEach((item) => URL.revokeObjectURL(item.url));
  }, [images]);

  function handleChange(event) {
    const { name, value } = event.target;
    setForm(current => ({ ...current, [name]: value }));
  }

  function handleImages(event) {
    const selection = validateImages(Array.from(event.target.files || []), 10 - images.length);
    setImages((current) => [...current, ...selection.files]);
    setError(selection.error);
    event.target.value = "";
  }

  function removeImage(index) {
    setImages((current) => current.filter((_, currentIndex) => currentIndex !== index));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!beginAction()) return;
    setMessage("");
    setError("");
    setCreated(null);

    try {
      if (!tagCode.trim()) {
        tagRef.current?.focus();
        throw new Error("Scanează eticheta lipită pe obiect. Fiecare obiect intră în inventar cu eticheta lui.");
      }
      if (tagCheck.state === "error") throw new Error(tagCheck.text);
      if (!form.location_id) throw new Error("Selectează locația inițială a obiectului.");
      if (!form.name.trim() || !form.category.trim()) throw new Error("Completează numele și categoria obiectului.");

      const newDevice = await createDevice({
        ...form,
        name: form.name.trim(),
        category: form.category.trim(),
        location_id: Number(form.location_id),
        responsible_person_id: form.responsible_person_id ? Number(form.responsible_person_id) : null,
        serial_number: form.serial_number || null,
        description: form.description || null,
        tag_code: tagCode.trim(),
      });

      let uploadedCount = 0;
      if (images.length) {
        try {
          const uploaded = await uploadDeviceImages(newDevice.id, images);
          uploadedCount = uploaded?.length || 0;
        } catch (uploadError) {
          setError(`Obiectul a fost creat, dar imaginile nu au putut fi încărcate: ${uploadError.message}`);
        }
      }

      const identity = newDevice.tag_code ? `${newDevice.code} (eticheta ${newDevice.tag_code})` : newDevice.code;
      setMessage(
        uploadedCount
          ? `${identity} a fost adăugat și are ${uploadedCount} ${uploadedCount === 1 ? "imagine" : "imagini"}.`
          : `${identity} a fost adăugat cu succes.`
      );
      setCreated(newDevice);
      setForm(initialForm);
      setTagCode("");
      setTagCheck({ state: "idle", text: "" });
      setImages([]);
      // Ready for the next sticker once the form is enabled again.
      focusTagAfterSave.current = true;
      await onDeviceAdded();
    } catch (err) {
      setError(err.message);
    } finally {
      endAction();
    }
  }

  return (
    <section className="page">
      <div className="page-intro">
        <div>
          <span className="page-kicker">NEW ASSET</span>
          <h2>Adaugă obiect</h2>
          <p>Înregistrează obiectul cu locația lui reală și fotografii încă din prima zi.</p>
        </div>
      </div>

      <div className="form-layout">
        <form className="panel form-panel" onSubmit={handleSubmit} aria-busy={saving || loadingOptions}>
          <div className="panel-header form-panel-header">
            <div><span className="panel-eyebrow">DETALII OBIECT</span><h3>Identitate și localizare</h3></div>
            <div className="form-step">01</div>
          </div>

          {!loadingOptions && locationsLoaded && !locations.length && (
            <div className="alert alert-error location-required-alert">
              <Icon name="pin" size={18} />
              <div>
                <strong>Ai nevoie de cel puțin o locație.</strong>
                <span>Un obiect nou nu mai poate intra în inventar fără să știm unde se află.</span>
              </div>
              <button type="button" className="btn btn-light" onClick={() => onNavigate?.("Locations")}>Adaugă locație</button>
            </div>
          )}

          <fieldset className="form-fields" disabled={saving || loadingOptions}>
          <label className={`field tag-scan-field ${tagCheck.state}`}>
            <span><Icon name="barcode" size={14} /> Etichetă *</span>
            <input
              ref={tagRef}
              name="tag_code"
              maxLength={40}
              placeholder="Scanează eticheta lipită pe obiect (INV-000123)"
              value={tagCode}
              onChange={(event) => { setTagCode(event.target.value); setTagCheck({ state: "idle", text: "" }); }}
              onKeyDown={handleTagKey}
              onBlur={() => checkTag(tagCode)}
              autoCapitalize="characters"
              spellCheck={false}
              required
              aria-invalid={tagCheck.state === "error"}
              aria-describedby="tag-scan-status"
            />
            <small id="tag-scan-status" role="status">{tagCheck.text || "Obligatorie. Lipește o etichetă pe obiect și scaneaz-o."}</small>
          </label>
          {tagCheck.state === "error" && tagCheck.text.includes("pagina Etichete") && (
            <button type="button" className="text-button tag-print-link" onClick={() => onNavigate?.("Tags")}>Tipărește etichete</button>
          )}
          <div className="form-grid two-cols">
            <label className="field"><span>Nume obiect *</span><input ref={nameRef} name="name" maxLength={200} placeholder="Ex. Osciloscop Hantek" value={form.name} onChange={handleChange} required /></label>
            <label className="field"><span>Categorie *</span><input name="category" maxLength={200} placeholder="Ex. Instrumentație" value={form.category} onChange={handleChange} required /></label>
            <label className="field"><span>Număr de serie</span><input name="serial_number" maxLength={255} placeholder="SN-2026-001" value={form.serial_number} onChange={handleChange} /></label>
            <label className="field"><span>Status inițial</span><select name="status" value={form.status} onChange={handleChange}><option value="AVAILABLE">Disponibil</option><option value="IN_USE">În uz</option><option value="BROKEN">Stricat</option><option value="LOST">Pierdut</option><option value="RETIRED">Scos din uz</option></select></label>
            <label className="field"><span>Responsabil obiect</span><select name="responsible_person_id" value={form.responsible_person_id} onChange={handleChange}><option value="">Fără responsabil</option>{responsibles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><small>Se configurează în Persoane. Rămâne asociat și în timpul împrumuturilor.</small></label>
            <label className="field field-location">
              <span><Icon name="pin" size={14} /> Locație inițială *</span>
              <select name="location_id" value={form.location_id} onChange={handleChange} required disabled={!locations.length}>
                <option value="">Selectează locația...</option>
                {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
              </select>
            </label>
          </div>

          <label className="field"><span>Descriere</span><textarea name="description" maxLength={10000} placeholder="Detalii utile, configurație, observații..." value={form.description} onChange={handleChange} /></label>

          <div className="asset-upload-section">
            <div className="upload-heading">
              <div><span className="panel-eyebrow">FOTOGRAFII</span><h3>Imagini ale obiectului</h3></div>
              <span className="upload-counter">{images.length}/10</span>
            </div>

            <label className="image-dropzone">
              <input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={handleImages} />
              <span className="dropzone-icon"><Icon name="upload" size={22} /></span>
              <strong>Încarcă fotografii</strong>
              <small>PNG, JPG sau WEBP · maximum 8 MB / imagine</small>
            </label>

            {previews.length > 0 && (
              <div className="pending-image-grid">
                {previews.map((item, index) => (
                  <div className="pending-image" key={`${item.file.name}-${index}`}>
                    <img src={item.url} alt={item.file.name} />
                    <button type="button" onClick={() => removeImage(index)} title="Elimină imaginea" aria-label={`Elimină fotografia ${item.file.name}`}><Icon name="close" size={14} /></button>
                    <span>{item.file.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          </fieldset>

          {loadingOptions && <p role="status">Se încarcă locațiile și responsabilii…</p>}
          {optionsError && <div className="alert alert-error" role="alert"><Icon name="alert" size={18} /><span>{optionsError}</span><button type="button" className="text-button" disabled={loadingOptions || saving} onClick={loadOptions}>Reîncearcă încărcarea listelor</button></div>}
          {message && <div className="alert alert-success" role="status"><Icon name="check" size={18} /><span>{message}</span>{created && onOpenDevice && <button type="button" className="text-button" onClick={() => onOpenDevice(created.id)}>Deschide fișa</button>}</div>}
          {error && <div className="alert alert-error" role="alert"><Icon name="alert" size={18} /><span>{error}</span></div>}

          <div className="form-footer">
            <button type="button" disabled={saving} className="btn btn-ghost" onClick={() => onNavigate?.("Inventory")}>Anulează</button>
            <button className="btn btn-primary" type="submit" disabled={saving || loadingOptions || !locations.length}><Icon name="plus" size={17} />{saving ? "Se salvează..." : "Adaugă în inventar"}</button>
          </div>
        </form>

        <aside className="form-aside">
          <div className="aside-card dark-card"><div className="aside-icon"><Icon name="inventory" /></div><h3>Obiect urmărit din prima zi</h3><p>Prima locație devine automat primul punct din istoricul obiectului. Fiecare mutare ulterioară este păstrată.</p></div>
          <div className="aside-card"><span className="panel-eyebrow">ETICHETĂ</span><h3>Lipește, scanează, salvează</h3><p>Etichetele se tipăresc în avans din pagina Etichete. Eticheta scanată aici devine identitatea fizică a obiectului; aplicația îi atribuie și un cod intern <code>DEV-00001</code>.</p></div>
        </aside>
      </div>
    </section>
  );
}
