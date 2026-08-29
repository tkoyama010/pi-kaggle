import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

const execAsync = promisify(exec);

// ponytail: use kaggle CLI instead of raw API — battle-tested, handles auth, rate limits, retries
async function runKaggle(args: string, cwd?: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(`kaggle ${args}`, { cwd });
    if (stderr && !stderr.includes("Warning") && !stderr.includes("Could not verify")) {
      console.error(`kaggle stderr: ${stderr}`);
    }
    return stdout.trim();
  } catch (err: any) {
    if (err.message?.includes("command not found") || err.message?.includes("'kaggle'")) {
      throw new Error("Kaggle CLI not installed. Run: pip install kaggle");
    }
    throw err;
  }
}

// Session state: remember active competition across sessions
interface KaggleState {
  activeCompetition?: string;
  activeDataset?: string;
  lastDownloadPath?: string;
}

async function loadState(cwd: string): Promise<KaggleState> {
  try {
    const { readFileSync } = await import("node:fs");
    const statePath = join(cwd, CONFIG_DIR_NAME, "kaggle-state.json");
    return JSON.parse(readFileSync(statePath, "utf-8"));
  } catch {
    return {};
  }
}

async function saveState(cwd: string, state: KaggleState): Promise<void> {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const statePath = join(cwd, CONFIG_DIR_NAME, "kaggle-state.json");
  mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export default function (pi: ExtensionAPI) {
  // ── Tools ──────────────────────────────────────────────────────────

  pi.registerTool({
    name: "kaggle_download",
    label: "Download Kaggle Data",
    description: "Download a dataset or competition files to the workspace",
    parameters: Type.Object({
      type: Type.String({
        enum: ["competition", "dataset"],
        description: "What to download: competition data or a dataset",
      }),
      slug: Type.String({
        description:
          "Competition slug (e.g. 'titanic') or dataset slug (e.g. 'user/dataset-name')",
      }),
      dest: Type.Optional(
        Type.String({ description: "Destination directory (default: ./data)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const dest = params.dest || "./data";
      try {
        const { mkdirSync } = await import("node:fs");
        mkdirSync(dest, { recursive: true });

        if (params.type === "competition") {
          await runKaggle(
            `competitions download -c ${params.slug} -p ${dest}`,
            ctx.cwd,
          );
        } else {
          await runKaggle(
            `datasets download -d ${params.slug} -p ${dest}`,
            ctx.cwd,
          );
        }

        // Extract zip files in dest directory
        const { exec: execNode } = await import("node:child_process");
        const { promisify: promisifyNode } = await import("node:util");
        const execAsyncNode = promisifyNode(execNode);
        await execAsyncNode(`find ${dest} -name '*.zip' -exec unzip -o {} -d ${dest} \\;`, { cwd: ctx.cwd }).catch(() => {
          // ponytail: unzip may fail if files already extracted, ignore
        });

        // Save state
        const state = await loadState(ctx.cwd);
        if (params.type === "competition") {
          state.activeCompetition = params.slug;
        } else {
          state.activeDataset = params.slug;
        }
        state.lastDownloadPath = dest;
        await saveState(ctx.cwd, state);

        return {
          content: [
            {
              type: "text",
              text: `Downloaded ${params.type} "${params.slug}" to ${dest}`,
            },
          ],
          details: { dest, type: params.type, slug: params.slug },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Download failed: ${err.message}` }],
          isError: true,
          details: { type: params.type, slug: params.slug },
        };
      }
    },
  });

  pi.registerTool({
    name: "kaggle_submit",
    label: "Submit to Kaggle",
    description: "Submit a prediction CSV to a Kaggle competition",
    parameters: Type.Object({
      competition: Type.String({
        description: "Competition slug (e.g. 'titanic')",
      }),
      filePath: Type.String({
        description: "Path to the submission CSV file",
      }),
      message: Type.Optional(
        Type.String({ description: "Submission message (optional)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const msg = params.message
          ? `-m "${params.message}"`
          : "";
        const output = await runKaggle(
          `competitions submit -c ${params.competition} -f ${params.filePath} ${msg}`,
          ctx.cwd,
        );
        // Save state
        const state = await loadState(ctx.cwd);
        state.activeCompetition = params.competition;
        await saveState(ctx.cwd, state);

        return {
          content: [{ type: "text", text: `Submission successful: ${output}` }],
          details: {
            competition: params.competition,
            file: params.filePath,
            message: params.message,
          },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Submission failed: ${err.message}` }],
          isError: true,
          details: { competition: params.competition, file: params.filePath },
        };
      }
    },
  });

  pi.registerTool({
    name: "kaggle_list",
    label: "List Kaggle Resources",
    description: "List or search Kaggle competitions or datasets",
    parameters: Type.Object({
      type: Type.String({
        enum: ["competitions", "datasets"],
        description: "What to list",
      }),
      query: Type.Optional(
        Type.String({ description: "Search keyword (optional)" }),
      ),
      sort: Type.Optional(
        Type.String({
          enum: [
            "deadline",
            "earliestDeadline",
            "latestDeadline",
            "maxTeams",
            "newest",
            "prize",
            "relevance",
            "votes",
            "updated",
          ],
          description: "Sort order (optional)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        let cmd = "";
        if (params.type === "competitions") {
          cmd = `competitions list --csv`;
          if (params.sort) cmd += ` --sort-by ${params.sort}`;
        } else {
          cmd = `datasets list --csv`;
          if (params.sort) cmd += ` --sort-by ${params.sort}`;
        }
        if (params.query) cmd += ` --search "${params.query}"`;

        const output = await runKaggle(cmd, ctx.cwd);
        return {
          content: [{ type: "text", text: output || "No results found" }],
          details: { type: params.type, query: params.query },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `List failed: ${err.message}` }],
          isError: true,
          details: { type: params.type },
        };
      }
    },
  });

  pi.registerTool({
    name: "kaggle_info",
    label: "Get Kaggle Info",
    description: "Get details about a Kaggle competition or dataset",
    parameters: Type.Object({
      type: Type.String({
        enum: ["competition", "dataset"],
        description: "What to get info about",
      }),
      slug: Type.String({
        description:
          "Competition slug (e.g. 'titanic') or dataset slug (e.g. 'user/dataset-name')",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        let output: string;
        if (params.type === "competition") {
          output = await runKaggle(
            `competitions view -c ${params.slug}`,
            ctx.cwd,
          );
        } else {
          output = await runKaggle(
            `datasets view -d ${params.slug}`,
            ctx.cwd,
          );
        }
        return {
          content: [{ type: "text", text: output || "No info found" }],
          details: { type: params.type, slug: params.slug },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Info lookup failed: ${err.message}` }],
          isError: true,
          details: { type: params.type, slug: params.slug },
        };
      }
    },
  });

  // ── Commands ───────────────────────────────────────────────────────

  pi.registerCommand("kaggle-setup", {
    description: "Check Kaggle API setup and credentials",
    handler: async (_args, ctx) => {
      try {
        await runKaggle("config path", ctx.cwd);
        ctx.ui.notify("Kaggle CLI installed and configured", "success");
      } catch (err: any) {
        ctx.ui.notify(
          `Kaggle setup issue: ${err.message}. Run: pip install kaggle && mkdir -p ~/.kaggle && put kaggle.json there`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("kaggle-competitions", {
    description: "List active Kaggle competitions",
    handler: async (args, ctx) => {
      try {
        const query = args || "";
        const output = await runKaggle(
          `competitions list --csv${query ? ` --search "${query}"` : ""}`,
          ctx.cwd,
        );
        ctx.ui.notify(
          output || "No competitions found",
          "info",
        );
      } catch (err: any) {
        ctx.ui.notify(`Failed: ${err.message}`, "error");
      }
    },
  });

  pi.registerCommand("kaggle-datasets", {
    description: "Search Kaggle datasets",
    handler: async (args, ctx) => {
      if (!args) {
        ctx.ui.notify("Usage: /kaggle-datasets <search-term>", "info");
        return;
      }
      try {
        const output = await runKaggle(
          `datasets list --csv --search "${args}"`,
          ctx.cwd,
        );
        ctx.ui.notify(output || "No datasets found", "info");
      } catch (err: any) {
        ctx.ui.notify(`Failed: ${err.message}`, "error");
      }
    },
  });

  // ── Context Injection ──────────────────────────────────────────────

  // Inject Kaggle workflow context at start of each agent turn
  pi.on("before_agent_start", async (event, ctx) => {
    const state = await loadState(ctx.cwd);
    if (!state.activeCompetition && !state.activeDataset) return;

    const contextParts = ["Kaggle session context:"];
    if (state.activeCompetition) {
      contextParts.push(`- Active competition: ${state.activeCompetition}`);
    }
    if (state.activeDataset) {
      contextParts.push(`- Active dataset: ${state.activeDataset}`);
    }
    if (state.lastDownloadPath) {
      contextParts.push(`- Data location: ${state.lastDownloadPath}`);
    }
    contextParts.push(
      "- When submitting predictions, use CSV format with correct column names",
    );
    contextParts.push(
      "- Always check competition rules before submitting",
    );

    return {
      message: {
        customType: "kaggle-context",
        content: contextParts.join("\n"),
        display: false,
      },
    };
  });

  // ── Session Lifecycle ──────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const state = await loadState(ctx.cwd);
    if (state.activeCompetition) {
      ctx.ui.setStatus("kaggle", `🏆 ${state.activeCompetition}`);
    }
  });
}
