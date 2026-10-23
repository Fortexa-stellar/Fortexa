"use client";

import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { PolicyConfig } from "@/lib/types/domain";
import {
  exportPolicyDocument,
  parsePolicyImport,
  policyImportMatchesActive,
  type PolicyExport,
} from "@/lib/policy/import-export";
import { generatePolicyDiff, groupDiffChanges } from "@/lib/validation/diff";

interface PolicyImportExportProps {
  currentPolicy: PolicyConfig | null;
  currentVersion: number | null;
  onImportApproved: (document: PolicyExport) => Promise<void>;
  isOperator: boolean;
  isLoading: boolean;
}

type ImportState =
  | { status: "idle" }
  | { status: "validating"; content: string }
  | { status: "error"; error: string }
  | { status: "diff_preview"; document: PolicyExport; activePolicy: PolicyConfig };

export function PolicyImportExport({
  currentPolicy,
  currentVersion,
  onImportApproved,
  isOperator,
  isLoading,
}: PolicyImportExportProps) {
  const [importState, setImportState] = useState<ImportState>({ status: "idle" });
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Export the active policy as JSON
   */
  async function loadActivePolicy(): Promise<{ policy: PolicyConfig; version: number }> {
    const response = await fetch("/api/policy", { cache: "no-store" });
    if (!response.ok) throw new Error("Failed to load the active policy.");
    const active = (await response.json()) as { policy?: PolicyConfig; version?: number };
    if (!active.policy || typeof active.version !== "number") {
      throw new Error("Active policy is unavailable.");
    }
    return { policy: active.policy, version: active.version };
  }

  async function exportPolicy() {
    try {
      const active = await loadActivePolicy();
      const json = JSON.stringify(exportPolicyDocument(active.policy, active.version), null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `policy-v${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      setImportState({
        status: "error",
        error: error instanceof Error ? error.message : "Export failed.",
      });
    }
  }

  /**
   * Validate and parse imported JSON
   */
  function handleFileSelect(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const content = e.target?.result as string;
        setImportState({ status: "validating", content });

        // Parse JSON
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch (err) {
          setImportState({
            status: "error",
            error: `Invalid JSON: ${err instanceof Error ? err.message : "Unknown parse error"}`,
          });
          return;
        }

        if (hasSensitiveField(parsed)) {
          setImportState({
            status: "error",
            error: "Policy contains a sensitive field and cannot be saved.",
          });
          return;
        }

        const result = parsePolicyImport(parsed);
        if (!result.ok) {
          setImportState({ status: "error", error: result.error });
          return;
        }

        const active = await loadActivePolicy();
        const mismatch = policyImportMatchesActive(result.document, active);
        if (mismatch) {
          setImportState({ status: "error", error: mismatch });
          return;
        }

        setImportState({
          status: "diff_preview",
          document: result.document,
          activePolicy: active.policy,
        });
      } catch (err) {
        setImportState({
          status: "error",
          error: err instanceof Error ? err.message : "Unknown error during import",
        });
      }
    };

    reader.onerror = () => {
      setImportState({
        status: "error",
        error: "Failed to read file",
      });
    };

    reader.readAsText(file);

    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  /**
   * Approve and save the imported policy
   */
  async function approveImport() {
    if (importState.status !== "diff_preview") return;

    setImporting(true);
    try {
      await onImportApproved(importState.document);
      setImportState({ status: "idle" });
    } catch (error) {
      setImportState({
        status: "error",
        error: error instanceof Error ? error.message : "Import failed.",
      });
    } finally {
      setImporting(false);
    }
  }

  /**
   * Cancel import and return to idle state
   */
  function cancelImport() {
    setImportState({ status: "idle" });
  }

  // Idle state: show export and import buttons
  if (importState.status === "idle") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Policy Import / Export</CardTitle>
          <CardDescription>
            Export the active policy as JSON or import a new policy with validation.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button
            onClick={exportPolicy}
            disabled={!currentPolicy || currentVersion === null || isLoading}
            variant="outline"
            className="gap-2"
          >
            <Download className="h-4 w-4" />
            Export Policy
          </Button>

          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={!isOperator || isLoading}
            variant="outline"
            className="gap-2"
            title={!isOperator ? "Viewer role cannot import policies" : undefined}
          >
            <Upload className="h-4 w-4" />
            Import Policy
          </Button>

          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            onChange={handleFileSelect}
            className="hidden"
            aria-label="Import policy JSON file"
          />
        </CardContent>
      </Card>
    );
  }

  // Validating state: show loading indicator
  if (importState.status === "validating") {
    return (
      <Card className="border-blue-500/40 bg-blue-500/10">
        <CardContent className="pt-6">
          <p className="text-sm text-blue-400">Validating policy JSON...</p>
        </CardContent>
      </Card>
    );
  }

  // Error state: show validation errors
  if (importState.status === "error") {
    return (
      <Card className="border-red-500/40">
        <CardHeader>
          <CardTitle className="text-red-400">Policy Transfer Failed</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Alert className="border-red-500/40 bg-red-500/10">
            <AlertTitle>Validation Error</AlertTitle>
            <AlertDescription>
              <pre className="whitespace-pre-wrap break-words text-xs">{importState.error}</pre>
            </AlertDescription>
          </Alert>
          <Button onClick={cancelImport} variant="outline">
            Close
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Diff preview state: show changes before saving
  if (importState.status === "diff_preview") {
    const diff = generatePolicyDiff(importState.activePolicy, importState.document.policy);
    const grouped = groupDiffChanges(diff);

    return (
      <Card className="border-amber-500/40 bg-amber-500/5">
        <CardHeader>
          <CardTitle>Review Changes</CardTitle>
          <CardDescription>
            The imported policy will make {diff.changes.length} change(s). Review them below before
            proceeding.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Summary stats */}
          <div className="flex flex-wrap gap-3 text-sm">
            {diff.summary.added > 0 && (
              <span className="rounded-lg bg-emerald-500/15 px-3 py-1 text-emerald-400">
                Added: <span className="font-semibold">{diff.summary.added}</span>
              </span>
            )}
            {diff.summary.removed > 0 && (
              <span className="rounded-lg bg-red-500/15 px-3 py-1 text-red-400">
                Removed: <span className="font-semibold">{diff.summary.removed}</span>
              </span>
            )}
            {diff.summary.modified > 0 && (
              <span className="rounded-lg bg-amber-500/15 px-3 py-1 text-amber-400">
                Modified: <span className="font-semibold">{diff.summary.modified}</span>
              </span>
            )}
          </div>

          {/* Grouped changes */}
          <div className="space-y-4">
            {Object.entries(grouped).map(([category, changes]) => (
              <div key={category} className="space-y-2">
                <p className="text-sm font-semibold text-[hsl(var(--muted-foreground))]">
                  {category}
                </p>
                <ul className="space-y-1 ml-2 border-l border-[hsl(var(--border))] pl-3">
                  {changes.map((change, idx) => (
                    <li
                      key={idx}
                      className={`text-xs font-mono rounded px-2 py-1 ${getChangeStyle(
                        change.type
                      )}`}
                    >
                      {getChangeIcon(change.type)} {formatChange(change)}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {/* JSON preview (optional, collapsible) */}
          <details className="mt-4 text-xs">
            <summary className="cursor-pointer text-[hsl(var(--muted-foreground))] hover:text-foreground">
              View raw JSON
            </summary>
            <pre className="mt-2 overflow-auto rounded bg-[hsl(var(--muted)/0.4)] p-2 text-xs max-h-48">
              {importState.jsonContent}
            </pre>
          </details>

          {/* Action buttons */}
          <div className="flex gap-2 pt-4">
            <Button onClick={approveImport} disabled={importing || !isOperator} className="gap-2">
              {importing ? "Importing..." : "Import & Save"}
            </Button>
            <Button onClick={cancelImport} variant="outline" disabled={importing}>
              Cancel
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return null;
}

// ── Helper functions ────────────────────────────────────────────────

function getChangeStyle(type: string): string {
  const styles: Record<string, string> = {
    added: "bg-emerald-500/15 text-emerald-400",
    removed: "bg-red-500/15 text-red-400",
    modified: "bg-amber-500/15 text-amber-400",
    unchanged: "text-[hsl(var(--muted-foreground))]",
  };
  return styles[type] || styles.unchanged;
}

function getChangeIcon(type: string): string {
  const icons: Record<string, string> = {
    added: "➕",
    removed: "➖",
    modified: "🔄",
    unchanged: "✓",
  };
  return icons[type] || "•";
}

function formatChange(change: ReturnType<typeof generatePolicyDiff>["changes"][0]): string {
  const path = change.path.replace(/\[\w+\]$/, "");

  switch (change.type) {
    case "added":
      return `${path}: added "${change.newValue}"`;
    case "removed":
      return `${path}: removed "${change.oldValue}"`;
    case "modified":
      return `${path}: ${change.oldValue} → ${change.newValue}`;
    case "unchanged":
      return `${path}: no change`;
  }
}
