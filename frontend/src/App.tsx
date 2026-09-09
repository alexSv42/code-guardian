import { useState, useEffect, useRef, useCallback } from "react";
import type { ScanResponse, CreateScanResponse, Vulnerability } from "./types";

const API_BASE = import.meta.env.DEV ? "http://localhost:3000" : "";
const POLL_INTERVAL_MS = 2000;

function App() {
  const [repoUrl, setRepoUrl] = useState("https://github.com/OWASP/NodeGoat");
  const [scanId, setScanId] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const pollStatus = useCallback(
    (id: string) => {
      stopPolling();
      intervalRef.current = setInterval(async () => {
        try {
          const res = await fetch(`${API_BASE}/api/scan/${id}`);
          const data: ScanResponse = await res.json();
          setScan(data);
          if (data.status === "Finished" || data.status === "Failed") {
            stopPolling();
          }
        } catch {
          stopPolling();
          setError("Lost connection to server");
        }
      }, POLL_INTERVAL_MS);
    },
    [stopPolling]
  );

  useEffect(() => stopPolling, [stopPolling]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setScan(null);
    setScanId(null);
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data: CreateScanResponse = await res.json();
      setScanId(data.scanId);
      setScan({ scanId: data.scanId, status: "Queued", vulnerabilities: [] });
      pollStatus(data.scanId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start scan");
    } finally {
      setLoading(false);
    }
  };

  const isTerminal = scan?.status === "Finished" || scan?.status === "Failed";

  return (
    <div style={s.page}>
      {/* Header */}
      <header style={s.header}>
        <div style={s.headerInner}>
          <div style={s.headerLeft}>
            <img src="/ox-logo.png" alt="OX Security" style={s.logo} />
            <span style={s.divider} />
            <span style={s.headerTitle}>Code Guardian</span>
          </div>
        </div>
      </header>

      {/* Hero */}
      <div style={s.hero}>
        <h1 style={s.title}>Security Scanner</h1>
        <p style={s.subtitle}>
          Scan any GitHub repository for critical vulnerabilities using Trivy
        </p>

        <form onSubmit={handleSubmit} style={s.form}>
          <div style={s.inputRow}>
            <input
              type="url"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              required
              disabled={!!scanId && !isTerminal}
              style={{
                ...s.input,
                ...(!!scanId && !isTerminal ? s.inputDisabled : {}),
              }}
            />
            <button
              type="submit"
              disabled={loading || (!!scanId && !isTerminal)}
              style={{
                ...s.btn,
                ...(loading || (!!scanId && !isTerminal) ? s.btnDisabled : {}),
              }}
            >
              {loading ? "Starting..." : scanId && !isTerminal ? "Scanning..." : "Start Scan"}
            </button>
          </div>
        </form>
      </div>

      {/* Main content */}
      <main style={s.main}>
        {error && (
          <div style={s.errorBar}>
            <span style={s.errorDot} />
            {error}
          </div>
        )}

        {scan && (
          <div style={s.card}>
            <div style={s.cardHeader}>
              <div style={s.statusRow}>
                <StatusDot status={scan.status} />
                <span style={s.statusText}>{scan.status}</span>
                {(scan.status === "Queued" || scan.status === "Scanning") && (
                  <span style={s.pollingBadge}>Polling every 2s</span>
                )}
              </div>
              {scanId && <code style={s.scanIdCode}>{scanId.slice(0, 8)}</code>}
            </div>

            {scan.status === "Failed" && scan.error && (
              <div style={s.failMsg}>{scan.error}</div>
            )}

            {scan.status === "Finished" && (
              <>
                <div style={s.summary}>
                  <SummaryCard value={scan.vulnerabilities.length} label="Critical Vulnerabilities" color="#E53E3E" />
                  <SummaryCard value={new Set(scan.vulnerabilities.map((v) => v.target)).size} label="Affected Targets" color="#4318FF" />
                  <SummaryCard value={new Set(scan.vulnerabilities.map((v) => v.pkgName)).size} label="Affected Packages" color="#DD6B20" />
                </div>

                {scan.vulnerabilities.length > 0 && (
                  <div style={s.tableWrap}>
                    <table style={s.table}>
                      <thead>
                        <tr>
                          <th style={s.th}>CVE</th>
                          <th style={s.th}>Package</th>
                          <th style={s.th}>Installed</th>
                          <th style={s.th}>Fixed In</th>
                          <th style={{ ...s.th, maxWidth: 320 }}>Title</th>
                          <th style={s.th}>Target</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scan.vulnerabilities.map((v, i) => (
                          <VulnRow key={i} vuln={v} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function SummaryCard({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div style={s.summaryCard}>
      <span style={{ ...s.summaryNum, color }}>{value}</span>
      <span style={s.summaryLabel}>{label}</span>
    </div>
  );
}

function VulnRow({ vuln }: { vuln: Vulnerability }) {
  return (
    <tr>
      <td style={s.td}>
        <a href={`https://nvd.nist.gov/vuln/detail/${vuln.vulnerabilityId}`} target="_blank" rel="noopener noreferrer" style={s.cveLink}>
          {vuln.vulnerabilityId}
        </a>
      </td>
      <td style={s.td}><code style={s.mono}>{vuln.pkgName}</code></td>
      <td style={s.td}><code style={s.monoRed}>{vuln.installedVersion}</code></td>
      <td style={s.td}><code style={s.monoGreen}>{vuln.fixedVersion ?? "—"}</code></td>
      <td style={{ ...s.td, maxWidth: 320 }}>{vuln.title}</td>
      <td style={s.td}><code style={s.mono}>{vuln.target}</code></td>
    </tr>
  );
}

function StatusDot({ status }: { status: string }) {
  const color = status === "Finished" ? "#38A169" : status === "Failed" ? "#E53E3E" : "#D69E2E";
  const pulse = status === "Queued" || status === "Scanning";
  return (
    <span style={{
      width: 10, height: 10, borderRadius: "50%",
      backgroundColor: color, display: "inline-block",
      boxShadow: pulse ? `0 0 6px ${color}` : undefined,
      animation: pulse ? "pulse 1.5s ease-in-out infinite" : undefined,
    }} />
  );
}

/* ─── Light theme – OX Security palette ─── */
const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    backgroundColor: "#F5F6FA",
    color: "#1A202C",
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },

  header: {
    backgroundColor: "#fff",
    borderBottom: "1px solid #E2E8F0",
    position: "sticky" as const,
    top: 0,
    zIndex: 10,
  },
  headerInner: {
    maxWidth: 1120,
    margin: "0 auto",
    padding: "12px 24px",
    display: "flex",
    alignItems: "center",
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  logo: { height: 24 },
  divider: {
    width: 1,
    height: 20,
    backgroundColor: "#E2E8F0",
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: 600,
    color: "#718096",
    letterSpacing: "-0.01em",
  },

  hero: {
    backgroundColor: "#fff",
    borderBottom: "1px solid #E2E8F0",
    padding: "48px 24px 40px",
    textAlign: "center" as const,
  },
  title: {
    fontSize: 32,
    fontWeight: 700,
    color: "#1A202C",
    margin: 0,
    letterSpacing: "-0.03em",
  },
  subtitle: {
    fontSize: 16,
    color: "#718096",
    marginTop: 8,
    marginBottom: 28,
  },
  form: {
    maxWidth: 660,
    margin: "0 auto",
  },
  inputRow: {
    display: "flex",
    gap: 10,
  },
  input: {
    flex: 1,
    padding: "12px 16px",
    borderRadius: 8,
    border: "1px solid #E2E8F0",
    backgroundColor: "#F7FAFC",
    color: "#1A202C",
    fontSize: 15,
    outline: "none",
  },
  inputDisabled: { opacity: 0.5, cursor: "not-allowed" },
  btn: {
    padding: "12px 28px",
    borderRadius: 8,
    border: "none",
    backgroundColor: "#4318FF",
    color: "#fff",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
    transition: "all 0.15s",
  },
  btnDisabled: { opacity: 0.5, cursor: "not-allowed" },

  main: {
    maxWidth: 1120,
    margin: "0 auto",
    padding: "28px 24px 60px",
  },

  errorBar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "12px 16px",
    borderRadius: 8,
    backgroundColor: "#FFF5F5",
    border: "1px solid #FED7D7",
    color: "#C53030",
    fontSize: 14,
    marginBottom: 20,
  },
  errorDot: {
    width: 6, height: 6, borderRadius: "50%",
    backgroundColor: "#E53E3E", flexShrink: 0,
  },

  card: {
    borderRadius: 12,
    border: "1px solid #E2E8F0",
    backgroundColor: "#fff",
    overflow: "hidden",
    boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 22px",
    borderBottom: "1px solid #EDF2F7",
  },
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  statusText: {
    fontSize: 15,
    fontWeight: 600,
    color: "#1A202C",
  },
  pollingBadge: {
    fontSize: 11,
    color: "#B7791F",
    fontWeight: 500,
    padding: "3px 8px",
    borderRadius: 6,
    backgroundColor: "#FFFFF0",
    border: "1px solid #FEFCBF",
  },
  scanIdCode: {
    fontSize: 13,
    color: "#A0AEC0",
    fontFamily: "monospace",
  },
  failMsg: {
    padding: "14px 22px",
    fontSize: 13,
    color: "#C53030",
    fontFamily: "monospace",
    backgroundColor: "#FFF5F5",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
  },

  summary: {
    display: "flex",
    gap: 14,
    padding: "22px 22px 0",
  },
  summaryCard: {
    flex: 1,
    padding: "18px 20px",
    borderRadius: 10,
    backgroundColor: "#F7FAFC",
    border: "1px solid #EDF2F7",
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
  },
  summaryNum: {
    fontSize: 30,
    fontWeight: 700,
    letterSpacing: "-0.02em",
  },
  summaryLabel: {
    fontSize: 11,
    color: "#718096",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },

  tableWrap: {
    overflowX: "auto" as const,
    margin: "22px",
    borderRadius: 8,
    border: "1px solid #EDF2F7",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: 13,
  },
  th: {
    textAlign: "left" as const,
    padding: "10px 14px",
    fontSize: 11,
    fontWeight: 700,
    color: "#4318FF",
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    borderBottom: "1px solid #EDF2F7",
    backgroundColor: "#FAFBFF",
    whiteSpace: "nowrap" as const,
  },
  td: {
    padding: "10px 14px",
    verticalAlign: "top" as const,
    lineHeight: 1.55,
    borderBottom: "1px solid #F7FAFC",
  },
  cveLink: {
    color: "#4318FF",
    textDecoration: "none",
    fontFamily: "monospace",
    fontSize: 12,
    fontWeight: 500,
  },
  mono: {
    fontFamily: "monospace",
    fontSize: 12,
    color: "#4A5568",
    backgroundColor: "#EDF2F7",
    padding: "2px 5px",
    borderRadius: 4,
  },
  monoRed: {
    fontFamily: "monospace",
    fontSize: 12,
    color: "#C53030",
    backgroundColor: "#FFF5F5",
    padding: "2px 5px",
    borderRadius: 4,
  },
  monoGreen: {
    fontFamily: "monospace",
    fontSize: 12,
    color: "#276749",
    backgroundColor: "#F0FFF4",
    padding: "2px 5px",
    borderRadius: 4,
  },
};

export default App;
