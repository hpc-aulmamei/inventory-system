import { useCallback, useEffect, useRef, useState } from "react";

import CommandPalette from "./components/CommandPalette";
import LoginScreen from "./components/LoginScreen";
import Navbar from "./components/Navbar";
import Sidebar from "./components/Sidebar";
import usePendingAction from "./hooks/usePendingAction";
import AddDevice from "./pages/AddDevice";
import Admin from "./pages/Admin";
import Dashboard from "./pages/Dashboard";
import DeviceDetail from "./pages/DeviceDetail";
import Inventory from "./pages/Inventory";
import Journal from "./pages/Journal";
import Loans from "./pages/Loans";
import Locations from "./pages/Locations";
import Logs from "./pages/Logs";
import People from "./pages/People";
import Tags from "./pages/Tags";
import {
  clearAdminSession,
  deleteDevice,
  getCurrentAdmin,
  getAdminSessionToken,
  getDevices,
  hasAdminSession,
  loginAdmin,
  logoutAdmin,
} from "./services/api";

export default function AdminApp({ theme, onToggleTheme }) {
  const [authState, setAuthState] = useState("checking");
  const [verificationError, setVerificationError] = useState("");
  const [verificationAttempt, setVerificationAttempt] = useState(0);
  const [currentPage, setCurrentPage] = useState("Dashboard");
  const [devices, setDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(null);
  const [addDeviceTag, setAddDeviceTag] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [error, setError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const [admin, setAdmin] = useState(null);
  const devicesRequest = useRef(0);
  const { busy: deleting, beginAction: beginDelete, endAction: endDelete } = usePendingAction();

  const loadDevices = useCallback(async () => {
    const session = getAdminSessionToken();
    const request = ++devicesRequest.current;
    try {
      const data = await getDevices();
      if (request !== devicesRequest.current || session !== getAdminSessionToken()) return;
      setDevices(data);
      setError("");
    } catch (err) {
      if (request === devicesRequest.current && session === getAdminSessionToken() && err.status !== 401) setError(err.message);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function verifySession() {
      const session = getAdminSessionToken();
      if (!hasAdminSession()) {
        if (!cancelled) setAuthState("unauthenticated");
        return;
      }

      try {
        const current = await getCurrentAdmin();
        if (!cancelled && session === getAdminSessionToken()) {
          setAdmin(current);
          setVerificationError("");
          setAuthState("authenticated");
        }
      } catch (err) {
        if (cancelled) return;
        if (err.status === 401) {
          // apiRequest already clears only the session used by this request.
          if (!hasAdminSession()) setAuthState("unauthenticated");
        } else if (session === getAdminSessionToken()) {
          setVerificationError(err.message);
          setAuthState("verification-error");
        }
      }
    }

    verifySession();
    return () => { cancelled = true; };
  }, [verificationAttempt]);

  useEffect(() => {
    function requireAuthentication() {
      devicesRequest.current += 1;
      setAuthState("unauthenticated");
      setAdmin(null);
      setDevices([]);
      setError("");
      setVerificationError("");
      setCommandOpen(false);
      setSidebarOpen(false);
    }

    window.addEventListener("inventory-auth-required", requireAuthentication);
    return () => window.removeEventListener("inventory-auth-required", requireAuthentication);
  }, []);

  useEffect(() => {
    if (authState === "authenticated") loadDevices();
  }, [authState, loadDevices]);

  useEffect(() => {
    if (authState !== "authenticated") return undefined;

    function handleShortcut(event) {
      const isCommand = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";
      if (isCommand) {
        event.preventDefault();
        const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
        if (dialog && !dialog.classList.contains("command-palette")) return;
        setSidebarOpen(false);
        setCommandOpen((value) => !value);
      }
      if (event.key === "Escape") setCommandOpen(false);
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [authState]);

  async function handleLogin(password, username) {
    setAdmin(await loginAdmin(password, username));
    setAuthState("authenticated");
    setVerificationError("");
    setCurrentPage("Dashboard");
    setError("");
  }

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    devicesRequest.current += 1;
    try {
      await logoutAdmin();
    } catch {
      clearAdminSession();
    }
    setAuthState("unauthenticated");
    setAdmin(null);
    setDevices([]);
    setCurrentPage("Dashboard");
    setSelectedDeviceId(null);
    setLoggingOut(false);
    setSidebarOpen(false);
    setCommandOpen(false);
    setError("");
  }

  async function handleDeleteDevice(deviceId) {
    if (deleting || !window.confirm("Sigur vrei să ștergi acest obiect?") || !beginDelete()) return;

    try {
      await deleteDevice(deviceId);
      if (selectedDeviceId === deviceId) {
        setSelectedDeviceId(null);
        setCurrentPage("Inventory");
      }
      await loadDevices();
    } catch (err) {
      if (err.status !== 401) setError(err.message);
    } finally {
      endDelete();
    }
  }

  function navigate(page) {
    setAddDeviceTag("");
    setCurrentPage(page);
    if (page !== "Device Detail") setSelectedDeviceId(null);
    setCommandOpen(false);
    setSidebarOpen(false);
    window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }

  // Scanning a free tag starts adding the item that tag was stuck on.
  function addDeviceWithTag(tagCode) {
    navigate("Add Device");
    setAddDeviceTag(tagCode);
  }

  function openDevice(deviceId) {
    setSelectedDeviceId(deviceId);
    setCurrentPage("Device Detail");
    setCommandOpen(false);
    setSidebarOpen(false);
    window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }

  function renderPage() {
    if (currentPage === "Dashboard") return <Dashboard devices={devices} onNavigate={navigate} />;
    if (currentPage === "Inventory") return <Inventory devices={devices} onDelete={handleDeleteDevice} onOpen={openDevice} onAddWithTag={addDeviceWithTag} deleting={deleting} />;
    if (currentPage === "Device Detail" && selectedDeviceId) {
      return <DeviceDetail deviceId={selectedDeviceId} onBack={() => navigate("Inventory")} onChanged={loadDevices} />;
    }
    if (currentPage === "Add Device") return <AddDevice key={addDeviceTag} initialTag={addDeviceTag} onDeviceAdded={loadDevices} onNavigate={navigate} onOpenDevice={openDevice} />;
    if (currentPage === "Tags") return <Tags />;
    if (currentPage === "People") return <People admin={admin} />;
    if (currentPage === "Locations") return <Locations />;
    if (currentPage === "Loans") return <Loans onInventoryChanged={loadDevices} />;
    if (currentPage === "Journal") return <Journal />;
    if (currentPage === "Logs") return <Logs />;
    if (currentPage === "Admin") return <Admin onCleared={loadDevices} />;
    return null;
  }

  if (authState !== "authenticated") {
    return (
      <LoginScreen
        theme={theme}
        onToggleTheme={onToggleTheme}
        onLogin={handleLogin}
        checking={authState === "checking"}
        verificationError={verificationError}
        onRetryVerification={() => {
          setVerificationError("");
          setAuthState("checking");
          setVerificationAttempt(attempt => attempt + 1);
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        inert={commandOpen}
        isOpen={sidebarOpen}
        currentPage={currentPage}
        setCurrentPage={navigate}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="content-shell" inert={sidebarOpen || commandOpen ? true : undefined}>
        <Navbar
          currentPage={currentPage}
          theme={theme}
          onToggleTheme={onToggleTheme}
          onToggleSidebar={() => setSidebarOpen(true)}
          onOpenCommand={() => { setSidebarOpen(false); setCommandOpen(true); }}
          onNavigate={navigate}
          onLogout={handleLogout}
          loggingOut={loggingOut}
          admin={admin}
        />

        <main className="main-content">
          {error && (
            <div className="alert alert-error global-alert">
              <strong>Operația nu a reușit.</strong>
              <span>{error}</span>
            </div>
          )}
          {renderPage()}
        </main>
      </div>

      <CommandPalette
        isOpen={commandOpen}
        currentPage={currentPage}
        onClose={() => setCommandOpen(false)}
        onNavigate={navigate}
      />
    </div>
  );
}
