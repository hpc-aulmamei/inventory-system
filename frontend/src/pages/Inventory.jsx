import { useEffect, useMemo, useRef, useState } from "react";
import DeviceTable from "../components/DeviceTable";
import Icon from "../components/Icon";
import { getLocations, getTag } from "../services/api";

// Tag codes look like INV-000123; anything else is an ordinary search.
const TAG_PATTERN = /^[A-Z]{2,6}-\d{3,}$/;

export default function Inventory({ devices, onDelete, onOpen, onAddWithTag, deleting = false }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [locations, setLocations] = useState([]);
  const [scanNotice, setScanNotice] = useState("");
  const searchRef = useRef(null);

  // Ready for a scanner on desktops; phones would open the on-screen keyboard.
  useEffect(() => {
    if (window.matchMedia?.("(pointer: fine)").matches) searchRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    getLocations(true).then(data => { if (!cancelled) setLocations(data); }).catch(() => {});
    return () => { cancelled = true; };
  }, [devices]);

  const locationMap = useMemo(
    () => Object.fromEntries((locations || []).map((location) => [location.id, location])),
    [locations]
  );

  const categories = useMemo(
    () => [...new Set(devices.map((d) => d.category).filter(Boolean))].sort(),
    [devices]
  );

  // A USB barcode scanner types the tag code followed by Enter.
  async function handleSearchKey(event) {
    if (event.key !== "Enter") return;
    const code = search.trim().toUpperCase();
    const match = devices.find((device) => device.code === code || device.tag_code === code);
    if (match) {
      event.preventDefault();
      setSearch("");
      onOpen?.(match.id);
      return;
    }
    if (!TAG_PATTERN.test(code)) return;
    event.preventDefault();
    try {
      const tag = await getTag(code);
      if (tag.status === "AVAILABLE") {
        onAddWithTag?.(tag.code);
      } else if (tag.status === "ASSIGNED" && tag.device) {
        onOpen?.(tag.device.id);
      } else {
        setScanNotice(`Eticheta ${tag.code} nu identifică un obiect.`);
      }
      setSearch("");
    } catch (err) {
      setScanNotice(err.status === 404 ? `Codul ${code} nu este o etichetă din inventar.` : err.message);
    }
  }

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return devices.filter((device) => {
      const locationName = locationMap[device.location_id]?.name || "";
      const matchesSearch = !needle || [device.name, device.code, device.tag_code, device.serial_number, device.category, locationName]
        .some((value) => String(value || "").toLowerCase().includes(needle));
      const matchesStatus = !status || device.status === status;
      const matchesCategory = !category || device.category === category;
      return matchesSearch && matchesStatus && matchesCategory;
    });
  }, [devices, search, status, category, locationMap]);

  return (
    <section className="page">
      <div className="page-intro">
        <div>
          <span className="page-kicker">ASSET REGISTRY</span>
          <h2>Inventar</h2>
          <p>Fiecare obiect are acum o locație curentă și un istoric de mutări care poate fi urmărit individual.</p>
        </div>
        <div className="count-chip"><strong>{filtered.length}</strong><span>din {devices.length}</span></div>
      </div>

      <div className="toolbar panel-toolbar">
        <div className="search-box">
          <Icon name="search" size={18} />
          <input type="search" aria-label="Caută în inventar" maxLength={200} value={search} onChange={(e) => { setSearch(e.target.value); setScanNotice(""); }} onKeyDown={handleSearchKey} ref={searchRef} placeholder="Caută sau scanează o etichetă..." />
        </div>
        <div className="toolbar-filters">
          <div className="select-wrap"><Icon name="filter" size={16} /><select aria-label="Starea obiectelor" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Toate statusurile</option><option value="AVAILABLE">Disponibile</option><option value="LOANED">Împrumutate</option><option value="IN_USE">În uz</option><option value="BROKEN">Stricate</option><option value="LOST">Pierdute</option><option value="RETIRED">Scoase din uz</option></select></div>
          <select aria-label="Categoria obiectelor" value={category} onChange={(e) => setCategory(e.target.value)}><option value="">Toate categoriile</option>{[...new Set([...categories, ...(category ? [category] : [])])].map((item) => <option key={item} value={item}>{item}</option>)}</select>
        </div>
      </div>

      {scanNotice && <div className="alert alert-error" role="alert"><Icon name="alert" size={17} />{scanNotice}</div>}
      <DeviceTable devices={filtered} locationMap={locationMap} onDelete={onDelete} onOpen={onOpen} deleting={deleting} />
    </section>
  );
}
