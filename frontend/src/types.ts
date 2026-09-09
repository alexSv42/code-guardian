export interface Vulnerability {
  vulnerabilityId: string;
  pkgName: string;
  severity: string;
  title: string;
  installedVersion: string | null;
  fixedVersion: string | null;
  target: string;
}

export interface ScanResponse {
  scanId: string;
  status: "Queued" | "Scanning" | "Finished" | "Failed";
  error?: string;
  vulnerabilities: Vulnerability[];
}

export interface CreateScanResponse {
  scanId: string;
  status: string;
}
