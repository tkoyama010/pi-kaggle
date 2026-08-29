import type { ExtensionAPI, ToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

const execAsync = promisify(exec);

// ── Kaggle CLI Runner ───────────────────────────────────────────────
// ponytail: wrap kaggle CLI instead of raw API — handles auth, rate limits, retries, pagination

async function runKaggle(args: string, cwd?: string): Promise<string> {
  const { stdout, stderr } = await execAsync(`kaggle ${args}`, { cwd });
  if (stderr && !stderr.includes("Warning") && !stderr.includes("Could not verify")) {
    console.error(`kaggle stderr: ${stderr}`);
  }
  return stdout.trim();
}

function kaggleError(msg: string): ToolResult {
  return {
    content: [{ type: "text", text: msg }],
    isError: true,
    details: {},
  };
}

function safeRun(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  return fn().catch((err: Error) => {
    if (err.message?.includes("command not found") || err.message?.includes("'kaggle'")) {
      return kaggleError("Kaggle CLI not installed. Run: pip install kaggle");
    }
    return kaggleError(err.message);
  });
}

// ── Session State ───────────────────────────────────────────────────
// Remembers active competition, dataset, kernel, last submission, etc.

interface KaggleState {
  activeCompetition?: string;
  activeDataset?: string;
  activeKernel?: string;
  lastDownloadPath?: string;
  lastSubmissionRef?: string;
  lastSubmissionScore?: string;
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

// ── Extract submission ref from output ──────────────────────────────
function extractSubmissionRef(output: string): string | undefined {
  const match = output.match(/Submission ref:\s*(\d+)/);
  return match?.[1];
}

export default function (pi: ExtensionAPI) {
  // ═══════════════════════════════════════════════════════════════════
  //  COMPETITION TOOLS
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "kaggle_competition_files",
    label: "List Competition Files",
    description: "List available files for a Kaggle competition before downloading",
    parameters: Type.Object({
      competition: Type.String({ description: "Competition slug (e.g. 'titanic')" }),
      pageSize: Type.Optional(Type.Number({ description: "Files per page (default: 20, max: 200)" })),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      return safeRun(async () => {
        let cmd = `competitions files ${params.competition} --csv`;
        if (params.pageSize) cmd += ` --page-size ${params.pageSize}`;
        const output = await runKaggle(cmd, ctx.cwd);
        return {
          content: [{ type: "text", text: output || "No files found" }],
          details: { competition: params.competition },
        };
      });
    },
  });

  pi.registerTool({
    name: "kaggle_download",
    label: "Download Kaggle Data",
    description: "Download competition data or a dataset to the workspace",
    parameters: Type.Object({
      type: Type.String({ enum: ["competition", "dataset"], description: "What to download" }),
      slug: Type.String({ description: "Competition slug or dataset slug (user/dataset-name)" }),
      dest: Type.Optional(Type.String({ description: "Destination directory (default: ./data)" })),
      file: Type.Optional(Type.String({ description: "Specific file to download (optional)" })),
      force: Type.Optional(Type.Boolean({ description: "Force overwrite existing files" })),
      unzip: Type.Optional(Type.Boolean({ description: "Unzip after download (datasets only)" })),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      return safeRun(async () => {
        const dest = params.dest || "./data";
        const { mkdirSync } = await import("node:fs");
        mkdirSync(dest, { recursive: true });

        const force = params.force ? "-o" : "";
        const quiet = "-q";

        if (params.type === "competition") {
          let cmd = `competitions download ${params.slug} -p ${dest} ${force} ${quiet}`;
          if (params.file) cmd += ` -f ${params.file}`;
          await runKaggle(cmd, ctx.cwd);
        } else {
          const unzip = params.unzip ? "--unzip" : "";
          let cmd = `datasets download ${params.slug} -p ${dest} ${force} ${quiet} ${unzip}`;
          if (params.file) cmd += ` -f ${params.file}`;
          await runKaggle(cmd, ctx.cwd);
        }

        // ponytail: unzip competitions manually (CLI has no --unzip for competitions)
        if (params.type === "competition") {
          const execAsync2 = promisify(exec);
          await execAsync2(`cd ${dest} && find . -name '*.zip' -exec unzip -o {} \\; 2>/dev/null`).catch(() => {});
        }

        const state = await loadState(ctx.cwd);
        if (params.type === "competition") state.activeCompetition = params.slug;
        else state.activeDataset = params.slug;
        state.lastDownloadPath = dest;
        await saveState(ctx.cwd, state);

        return {
          content: [{ type: "text", text: `Downloaded ${params.type} "${params.slug}" to ${dest}` }],
          details: { dest, type: params.type, slug: params.slug },
        };
      });
    },
  });

  pi.registerTool({
    name: "kaggle_submit",
    label: "Submit to Kaggle Competition",
    description: "Submit a prediction CSV or kernel to a Kaggle competition",
    parameters: Type.Object({
      competition: Type.Optional(Type.String({ description: "Competition slug (uses active if omitted)" })),
      filePath: Type.String({ description: "Path to submission CSV file" }),
      message: Type.Optional(Type.String({ description: "Submission message" })),
      kernel: Type.Optional(Type.String({ description: "Kernel name for code competitions (owner/kernel-slug)" })),
      version: Type.Optional(Type.String({ description: "Kernel version for code competitions" })),
      wait: Type.Optional(Type.Boolean({ description: "Wait for scoring to complete (timeout: 10 min)" })),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      return safeRun(async () => {
        const state = await loadState(ctx.cwd);
        const comp = params.competition || state.activeCompetition;
        if (!comp) {
          return kaggleError("No competition specified and no active competition. Set one first.");
        }

        let cmd = `competitions submit ${comp} -f ${params.filePath}`;
        if (params.message) cmd += ` -m "${params.message}"`;
        if (params.kernel) cmd += ` -k ${params.kernel}`;
        if (params.version) cmd += ` -v ${params.version}`;
        if (params.wait) cmd += ` --wait 600`;

        const output = await runKaggle(cmd, ctx.cwd);

        const ref = extractSubmissionRef(output);
        state.activeCompetition = comp;
        if (ref) state.lastSubmissionRef = ref;
        await saveState(ctx.cwd, state);

        return {
          content: [{ type: "text", text: output }],
          details: { competition: comp, file: params.filePath, submissionRef: ref },
        };
      });
    },
  });

  pi.registerTool({
    name: "kaggle_submissions",
    label: "List Competition Submissions",
    description: "Show past submissions for a competition with scores",
    parameters: Type.Object({
      competition: Type.Optional(Type.String({ description: "Competition slug (uses active if omitted)" })),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      return safeRun(async () => {
        const state = await loadState(ctx.cwd);
        const comp = params.competition || state.activeCompetition;
        if (!comp) return kaggleError("No competition specified and no active competition.");

        const output = await runKaggle(`competitions submissions ${comp} --csv`, ctx.cwd);
        return {
          content: [{ type: "text", text: output || "No submissions found" }],
          details: { competition: comp },
        };
      });
    },
  });

  pi.registerTool({
    name: "kaggle_submission_status",
    label: "Check Submission Status",
    description: "Check status and score of a specific submission by its ref number",
    parameters: Type.Object({
      submissionRef: Type.Optional(Type.String({ description: "Submission ref number (uses last if omitted)" })),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      return safeRun(async () => {
        const state = await loadState(ctx.cwd);
        const ref = params.submissionRef || state.lastSubmissionRef;
        if (!ref) return kaggleError("No submission ref specified and no previous submission.");

        const output = await runKaggle(`competitions submission ${ref}`, ctx.cwd);
        // Extract score for state
        const scoreMatch = output.match(/Public Score:\s*(.+)/);
        if (scoreMatch) state.lastSubmissionScore = scoreMatch[1].trim();
        await saveState(ctx.cwd, state);

        return {
          content: [{ type: "text", text: output }],
          details: { submissionRef: ref },
        };
      });
    },
  });

  pi.registerTool({
    name: "kaggle_leaderboard",
    label: "View Kaggle Leaderboard",
    description: "View competition leaderboard — see your rank and top scores",
    parameters: Type.Object({
      competition: Type.Optional(Type.String({ description: "Competition slug (uses active if omitted)" })),
      download: Type.Optional(Type.Boolean({ description: "Download full leaderboard CSV (default: show top)" })),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      return safeRun(async () => {
        const state = await loadState(ctx.cwd);
        const comp = params.competition || state.activeCompetition;
        if (!comp) return kaggleError("No competition specified and no active competition.");

        let cmd = `competitions leaderboard ${comp}`;
        if (params.download) {
          cmd += ` -d -p .`;
        } else {
          cmd += ` -s --csv`;
        }
        const output = await runKaggle(cmd, ctx.cwd);
        return {
          content: [{ type: "text", text: params.download ? `Leaderboard downloaded for ${comp}` : (output || "No leaderboard data") }],
          details: { competition: comp },
        };
      });
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  KERNEL (NOTEBOOK) TOOLS — critical for code competitions
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "kaggle_kernel_push",
    label: "Push Kernel to Kaggle",
    description: "Push a notebook/script and metadata to Kaggle, then run it remotely",
    parameters: Type.Object({
      path: Type.String({ description: "Path to folder containing kernel file and kernel-metadata.json" }),
      accelerator: Type.Optional(Type.String({
        enum: ["NvidiaTeslaT4", "NvidiaTeslaA100", "NvidiaL4", "TpuV5E8", "TpuV6E8", "NvidiaH100", "NvidiaRtxPro6000"],
        description: "GPU/TPU accelerator for the kernel run",
      })),
      timeout: Type.Optional(Type.Number({ description: "Max run time in seconds" })),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      return safeRun(async () => {
        let cmd = `kernels push -p ${params.path}`;
        if (params.accelerator) cmd += ` --accelerator ${params.accelerator}`;
        if (params.timeout) cmd += ` -t ${params.timeout}`;

        const output = await runKaggle(cmd, ctx.cwd);

        // Extract kernel slug from metadata or output
        const { readFileSync } = await import("node:fs");
        try {
          const meta = JSON.parse(readFileSync(join(params.path, "kernel-metadata.json"), "utf-8"));
          const slug = meta.id || `${meta.codeFile?.split("/")[0] || "unknown"}/${meta.title?.toLowerCase().replace(/\s+/g, "-")}`;
          const state = await loadState(ctx.cwd);
          state.activeKernel = slug;
          await saveState(ctx.cwd, state);
        } catch { /* metadata parse failure, skip state update */ }

        return {
          content: [{ type: "text", text: output || "Kernel pushed successfully" }],
          details: { path: params.path, accelerator: params.accelerator },
        };
      });
    },
  });

  pi.registerTool({
    name: "kaggle_kernel_pull",
    label: "Pull Kernel from Kaggle",
    description: "Pull a kernel (notebook/script) and optionally its metadata from Kaggle",
    parameters: Type.Object({
      kernel: Type.String({ description: "Kernel slug (owner/kernel-slug or owner/kernel-slug/version)" }),
      dest: Type.Optional(Type.String({ description: "Destination directory" })),
      metadata: Type.Optional(Type.Boolean({ description: "Also download kernel-metadata.json" })),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      return safeRun(async () => {
        let cmd = `kernels pull ${params.kernel}`;
        if (params.dest) cmd += ` -p ${params.dest}`;
        else cmd += ` --wp`;
        if (params.metadata) cmd += ` -m`;

        const output = await runKaggle(cmd, ctx.cwd);
        const state = await loadState(ctx.cwd);
        state.activeKernel = params.kernel;
        await saveState(ctx.cwd, state);

        return {
          content: [{ type: "text", text: output || `Pulled kernel ${params.kernel}` }],
          details: { kernel: params.kernel, dest: params.dest || "." },
        };
      });
    },
  });

  pi.registerTool({
    name: "kaggle_kernel_status",
    label: "Check Kernel Run Status",
    description: "Check if the latest kernel run completed, is still running, or failed",
    parameters: Type.Object({
      kernel: Type.Optional(Type.String({ description: "Kernel slug (uses active if omitted)" })),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      return safeRun(async () => {
        const state = await loadState(ctx.cwd);
        const kernel = params.kernel || state.activeKernel;
        if (!kernel) return kaggleError("No kernel specified and no active kernel.");

        const output = await runKaggle(`kernels status ${kernel}`, ctx.cwd);
        return {
          content: [{ type: "text", text: output }],
          details: { kernel },
        };
      });
    },
  });

  pi.registerTool({
    name: "kaggle_kernel_output",
    label: "Download Kernel Output",
    description: "Download output files from the latest kernel run (e.g. submission.csv)",
    parameters: Type.Object({
      kernel: Type.Optional(Type.String({ description: "Kernel slug (uses active if omitted)" })),
      dest: Type.Optional(Type.String({ description: "Destination directory" })),
      filePattern: Type.Optional(Type.String({ description: "Regex pattern to filter files (e.g. '.*\\.csv$')" })),
      force: Type.Optional(Type.Boolean({ description: "Force overwrite existing files" })),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      return safeRun(async () => {
        const state = await loadState(ctx.cwd);
        const kernel = params.kernel || state.activeKernel;
        if (!kernel) return kaggleError("No kernel specified and no active kernel.");

        let cmd = `kernels output ${kernel}`;
        if (params.dest) cmd += ` -p ${params.dest}`;
        else cmd += ` --wp`;
        if (params.filePattern) cmd += ` --file-pattern "${params.filePattern}"`;
        if (params.force) cmd += ` -o`;

        const output = await runKaggle(cmd, ctx.cwd);
        return {
          content: [{ type: "text", text: output || `Output downloaded for ${kernel}` }],
          details: { kernel, dest: params.dest || "." },
        };
      });
    },
  });

  pi.registerTool({
    name: "kaggle_kernel_init",
    label: "Initialize Kernel Metadata",
    description: "Create a kernel-metadata.json template for a new kernel",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Path to folder (default: current directory)" })),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      return safeRun(async () => {
        const path = params.path || ".";
        const output = await runKaggle(`kernels init -p ${path}`, ctx.cwd);
        return {
          content: [{ type: "text", text: output || `Created kernel-metadata.json in ${path}` }],
          details: { path },
        };
      });
    },
  });

  pi.registerTool({
    name: "kaggle_kernels_list",
    label: "List Kaggle Kernels",
    description: "Search and list Kaggle kernels (notebooks/scripts) with filters",
    parameters: Type.Object({
      mine: Type.Optional(Type.Boolean({ description: "Show only your kernels" })),
      search: Type.Optional(Type.String({ description: "Search term" })),
      competition: Type.Optional(Type.String({ description: "Filter by competition slug" })),
      language: Type.Optional(Type.String({ enum: ["python", "r", "sqlite", "julia"], description: "Filter by language" })),
      kernelType: Type.Optional(Type.String({ enum: ["script", "notebook"], description: "Filter by type" })),
      sortBy: Type.Optional(Type.String({
        enum: ["hotness", "scoreDescending", "dateCreated", "voteCount", "viewCount"],
        description: "Sort order",
      })),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      return safeRun(async () => {
        let cmd = "kernels list --csv";
        if (params.mine) cmd += " -m";
        if (params.search) cmd += ` -s "${params.search}"`;
        if (params.competition) cmd += ` --competition ${params.competition}`;
        if (params.language) cmd += ` --language ${params.language}`;
        if (params.kernelType) cmd += ` --kernel-type ${params.kernelType}`;
        if (params.sortBy) cmd += ` --sort-by ${params.sortBy}`;

        const output = await runKaggle(cmd, ctx.cwd);
        return {
          content: [{ type: "text", text: output || "No kernels found" }],
          details: { search: params.search, competition: params.competition },
        };
      });
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  DATASET TOOLS
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "kaggle_dataset_files",
    label: "List Dataset Files",
    description: "List individual files within a Kaggle dataset before downloading",
    parameters: Type.Object({
      dataset: Type.String({ description: "Dataset slug (owner/dataset-name)" }),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      return safeRun(async () => {
        const output = await runKaggle(`datasets files ${params.dataset} --csv`, ctx.cwd);
        return {
          content: [{ type: "text", text: output || "No files found" }],
          details: { dataset: params.dataset },
        };
      });
    },
  });

  pi.registerTool({
    name: "kaggle_dataset_create",
    label: "Create Kaggle Dataset",
    description: "Create a new dataset on Kaggle from a local folder",
    parameters: Type.Object({
      path: Type.String({ description: "Path to folder containing data files and dataset-metadata.json" }),
      public: Type.Optional(Type.Boolean({ description: "Make dataset public (default: private)" })),
      quiet: Type.Optional(Type.Boolean({ description: "Suppress verbose output" })),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      return safeRun(async () => {
        let cmd = `datasets create -p ${params.path}`;
        if (params.public) cmd += " --public";
        if (params.quiet) cmd += " -q";

        const output = await runKaggle(cmd, ctx.cwd);
        return {
          content: [{ type: "text", text: output || "Dataset created" }],
          details: { path: params.path },
        };
      });
    },
  });

  pi.registerTool({
    name: "kaggle_dataset_version",
    label: "Create Dataset Version",
    description: "Create a new version of an existing Kaggle dataset",
    parameters: Type.Object({
      path: Type.String({ description: "Path to folder with updated files and dataset-metadata.json" }),
      message: Type.String({ description: "Version notes (required)" }),
      deleteOld: Type.Optional(Type.Boolean({ description: "Delete old versions" })),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      return safeRun(async () => {
        let cmd = `datasets version -p ${params.path} -m "${params.message}"`;
        if (params.deleteOld) cmd += " -d";

        const output = await runKaggle(cmd, ctx.cwd);
        return {
          content: [{ type: "text", text: output || "Dataset version created" }],
          details: { path: params.path, message: params.message },
        };
      });
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  DISCUSSION / FORUM TOOLS
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "kaggle_topics",
    label: "List Competition Topics",
    description: "Browse competition discussion forums for insights, feature engineering ideas, and solution approaches",
    parameters: Type.Object({
      competition: Type.Optional(Type.String({ description: "Competition slug (uses active if omitted)" })),
      sortBy: Type.Optional(Type.String({ enum: ["hot", "top", "new", "recent", "active"], description: "Sort order" })),
      search: Type.Optional(Type.String({ description: "Search topics" })),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      return safeRun(async () => {
        const state = await loadState(ctx.cwd);
        const comp = params.competition || state.activeCompetition;
        if (!comp) return kaggleError("No competition specified and no active competition.");

        let cmd = `competitions topics list ${comp} --csv`;
        if (params.sortBy) cmd += ` -s ${params.sortBy}`;
        if (params.search) cmd += ` --search "${params.search}"`;

        const output = await runKaggle(cmd, ctx.cwd);
        return {
          content: [{ type: "text", text: output || "No topics found" }],
          details: { competition: comp },
        };
      });
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  CONFIG TOOLS
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "kaggle_config",
    label: "Manage Kaggle Config",
    description: "View or set Kaggle CLI configuration (e.g. set default competition)",
    parameters: Type.Object({
      action: Type.String({ enum: ["view", "set", "unset"], description: "Action: view current config, set a value, or unset" }),
      key: Type.Optional(Type.String({ description: "Config key (e.g. 'competition', 'path')" })),
      value: Type.Optional(Type.String({ description: "Config value (for 'set' action)" })),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      return safeRun(async () => {
        let cmd = "config";
        if (params.action === "view") cmd += " view";
        else if (params.action === "set" && params.key) {
          cmd += ` set ${params.key}`;
          if (params.value) cmd += ` ${params.value}`;
          if (params.key === "competition") {
            const state = await loadState(ctx.cwd);
            state.activeCompetition = params.value;
            await saveState(ctx.cwd, state);
          }
        } else if (params.action === "unset" && params.key) {
          cmd += ` unset ${params.key}`;
        }
        const output = await runKaggle(cmd, ctx.cwd);
        return {
          content: [{ type: "text", text: output || `Config ${params.action}d` }],
          details: { action: params.action, key: params.key },
        };
      });
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  EXISTING TOOLS (kept from original, updated)
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "kaggle_list",
    label: "List Kaggle Resources",
    description: "List or search Kaggle competitions or datasets",
    parameters: Type.Object({
      type: Type.String({ enum: ["competitions", "datasets"], description: "What to list" }),
      query: Type.Optional(Type.String({ description: "Search keyword" })),
      sort: Type.Optional(Type.String({
        enum: ["deadline", "earliestDeadline", "latestDeadline", "maxTeams", "newest", "prize", "relevance", "votes", "updated", "hottest"],
        description: "Sort order",
      })),
      group: Type.Optional(Type.String({ enum: ["general", "entered", "inClass"], description: "Competition group filter" }),),
      category: Type.Optional(Type.String({ enum: ["all", "featured", "research", "gettingStarted", "playground"], description: "Competition category filter" })),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      return safeRun(async () => {
        let cmd = "";
        if (params.type === "competitions") {
          cmd = "competitions list --csv";
          if (params.sort) cmd += ` --sort-by ${params.sort}`;
          if (params.group) cmd += ` --group ${params.group}`;
          if (params.category) cmd += ` --category ${params.category}`;
        } else {
          cmd = "datasets list --csv";
          if (params.sort) cmd += ` --sort-by ${params.sort}`;
        }
        if (params.query) cmd += ` --search "${params.query}"`;

        const output = await runKaggle(cmd, ctx.cwd);
        return {
          content: [{ type: "text", text: output || "No results found" }],
          details: { type: params.type, query: params.query },
        };
      });
    },
  });

  pi.registerTool({
    name: "kaggle_info",
    label: "Get Kaggle Info",
    description: "Get details about a Kaggle competition or dataset",
    parameters: Type.Object({
      type: Type.String({ enum: ["competition", "dataset"], description: "What to get info about" }),
      slug: Type.String({ description: "Competition or dataset slug" }),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      return safeRun(async () => {
        const output = params.type === "competition"
          ? await runKaggle(`competitions view -c ${params.slug}`, ctx.cwd)
          : await runKaggle(`datasets metadata ${params.slug}`, ctx.cwd);
        return {
          content: [{ type: "text", text: output || "No info found" }],
          details: { type: params.type, slug: params.slug },
        };
      });
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  COMMANDS
  // ═══════════════════════════════════════════════════════════════════

  pi.registerCommand("kaggle-setup", {
    description: "Check Kaggle CLI installation and API credentials",
    handler: async (_args, ctx) => {
      try {
        await runKaggle("config view", ctx.cwd);
        ctx.ui.notify("Kaggle CLI installed and configured", "success");
      } catch (err: any) {
        ctx.ui.notify(
          "Kaggle setup needed: 1) pip install kaggle  2) kaggle auth login (or put token in ~/.kaggle/access_token)",
          "error",
        );
      }
    },
  });

  pi.registerCommand("kaggle-competitions", {
    description: "List Kaggle competitions (filter: entered/featured/playground)",
    handler: async (args, ctx) => {
      try {
        const filter = args ? ` --group ${args}` : "";
        const output = await runKaggle(`competitions list --csv${filter}`, ctx.cwd);
        ctx.ui.notify(output || "No competitions found", "info");
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
        const output = await runKaggle(`datasets list --csv --search "${args}"`, ctx.cwd);
        ctx.ui.notify(output || "No datasets found", "info");
      } catch (err: any) {
        ctx.ui.notify(`Failed: ${err.message}`, "error");
      }
    },
  });

  pi.registerCommand("kaggle-set", {
    description: "Set active competition for this workspace",
    handler: async (args, ctx) => {
      if (!args) {
        ctx.ui.notify("Usage: /kaggle-set <competition-slug>", "info");
        return;
      }
      const state = await loadState(ctx.cwd);
      state.activeCompetition = args.trim();
      await saveState(ctx.cwd, state);
      ctx.ui.notify(`Active competition set to: ${args.trim()}`, "success");
    },
  });

  pi.registerCommand("kaggle-status", {
    description: "Show current Kaggle workspace status (active competition, kernel, last submission)",
    handler: async (_args, ctx) => {
      const state = await loadState(ctx.cwd);
      const lines: string[] = ["Kaggle workspace status:"];
      if (state.activeCompetition) lines.push(`  Competition: ${state.activeCompetition}`);
      if (state.activeDataset) lines.push(`  Dataset: ${state.activeDataset}`);
      if (state.activeKernel) lines.push(`  Kernel: ${state.activeKernel}`);
      if (state.lastSubmissionRef) lines.push(`  Last submission: ${state.lastSubmissionRef}${state.lastSubmissionScore ? ` (score: ${state.lastSubmissionScore})` : ""}`);
      if (state.lastDownloadPath) lines.push(`  Data: ${state.lastDownloadPath}`);
      if (lines.length === 1) lines.push("  (no active resources)");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  CONTEXT INJECTION — every agent turn gets Kaggle awareness
  // ═══════════════════════════════════════════════════════════════════

  pi.on("before_agent_start", async (event, ctx) => {
    const state = await loadState(ctx.cwd);
    if (!state.activeCompetition && !state.activeDataset && !state.activeKernel) return;

    const parts = ["Kaggle workspace context:"];
    if (state.activeCompetition) parts.push(`- Active competition: ${state.activeCompetition}`);
    if (state.activeDataset) parts.push(`- Active dataset: ${state.activeDataset}`);
    if (state.activeKernel) parts.push(`- Active kernel: ${state.activeKernel}`);
    if (state.lastDownloadPath) parts.push(`- Data location: ${state.lastDownloadPath}`);
    if (state.lastSubmissionRef) {
      parts.push(`- Last submission ref: ${state.lastSubmissionRef}`);
      if (state.lastSubmissionScore) parts.push(`- Last score: ${state.lastSubmissionScore}`);
    }
    parts.push("- Submission files must be CSV with correct column names matching sample_submission.csv");
    parts.push("- For code competitions: push kernel, check status, then download output");
    parts.push("- Use kaggle_leaderboard to track rank, kaggle_submissions for submission history");

    return {
      message: { customType: "kaggle-context", content: parts.join("\n"), display: false },
    };
  });

  // ═══════════════════════════════════════════════════════════════════
  //  SESSION LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════

  pi.on("session_start", async (_event, ctx) => {
    const state = await loadState(ctx.cwd);
    const parts: string[] = [];
    if (state.activeCompetition) parts.push(state.activeCompetition);
    if (state.activeKernel) parts.push(state.activeKernel);
    if (parts.length > 0) {
      ctx.ui.setStatus("kaggle", `kaggle: ${parts.join(" | ")}`);
    }
  });
}
