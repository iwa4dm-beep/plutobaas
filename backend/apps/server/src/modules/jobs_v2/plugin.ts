// Phase 62 — Jobs v2 plugin.
//
// Endpoints (gated by PLUTO_ENABLE_JOBS_V2=1):
//   GET  /jobs/v2/workflows            — list registered workflows
//   POST /jobs/v2/runs                 — start a run for a named workflow
//   GET  /jobs/v2/runs/:id             — inspect run + step ledger
//   GET  /jobs/v2/runs                 — list all runs
//
// Ships one built-in `echo` workflow so the endpoints are useful without
// out-of-band setup. Real deployments call `registerWorkflow()` at boot.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getRun, listRuns, runWorkflow } from "../../lib/workflow-engine.js";
import { getWorkflow, listWorkflows, registerWorkflow } from "../../lib/workflow-registry.js";

const enabled = process.env.PLUTO_ENABLE_JOBS_V2 === "1";

function ensureBuiltins(ws: string) {
  if (getWorkflow(ws, "echo")) return;
  registerWorkflow(ws, {
    name: "echo",
    version: 1,
    steps: [
      {
        id: "start",
        run: async ({ input }) => ({ hello: input }),
      },
      {
        id: "shout",
        deps: ["start"],
        run: async ({ outputs }) => ({ shout: JSON.stringify(outputs.start).toUpperCase() }),
      },
    ],
  });
}

export async function jobsV2Plugin(app: FastifyInstance) {
  if (!enabled) return;

  app.addHook("preHandler", async (req, reply) => {
    const ws = req.headers["x-workspace-id"] as string | undefined;
    if (!ws) { reply.code(400); return { error: "missing_workspace" }; }
    ensureBuiltins(ws);
  });

  app.get("/jobs/v2/workflows", async (req) => {
    const ws = req.headers["x-workspace-id"] as string;
    return {
      workflows: listWorkflows(ws).map((w) => ({
        name: w.name, version: w.version,
        steps: w.steps.map((s) => ({ id: s.id, deps: s.deps ?? [] })),
      })),
    };
  });

  app.post("/jobs/v2/runs", async (req, reply) => {
    const ws = req.headers["x-workspace-id"] as string;
    const b = z.object({
      workflow: z.string(),
      input: z.unknown().optional(),
      run_id: z.string().optional(),
    }).safeParse(req.body);
    if (!b.success) { reply.code(400); return { error: "bad_request", issues: b.error.issues }; }
    const wf = getWorkflow(ws, b.data.workflow);
    if (!wf) { reply.code(404); return { error: "workflow_not_found" }; }
    const run = await runWorkflow(wf, b.data.input, b.data.run_id);
    reply.code(run.status === "failed" ? 200 : 200);
    return { run };
  });

  app.get("/jobs/v2/runs/:id", async (req, reply) => {
    const run = getRun((req.params as { id: string }).id);
    if (!run) { reply.code(404); return { error: "not_found" }; }
    return { run };
  });

  app.get("/jobs/v2/runs", async () => ({ runs: listRuns() }));
}
