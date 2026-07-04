// Phase 62 — Workflow registry.
//
// Workflows are declared in code and registered per workspace. The
// registry is intentionally in-memory so tests can swap definitions
// freely; production callers persist WorkflowDefs alongside their app
// code and re-register on boot.

import type { WorkflowDef } from "./workflow-engine.js";

const registry = new Map<string, WorkflowDef>();
const key = (ws: string, name: string) => `${ws}::${name}`;

export function registerWorkflow(workspace_id: string, wf: WorkflowDef) {
  if (!/^[a-z_][a-z0-9_.]*$/i.test(wf.name)) throw new Error("bad_workflow_name");
  registry.set(key(workspace_id, wf.name), wf);
  return wf;
}

export function getWorkflow(workspace_id: string, name: string): WorkflowDef | undefined {
  return registry.get(key(workspace_id, name));
}

export function listWorkflows(workspace_id: string): WorkflowDef[] {
  return Array.from(registry.entries())
    .filter(([k]) => k.startsWith(`${workspace_id}::`))
    .map(([, v]) => v);
}

export function _resetRegistryForTests() { registry.clear(); }
