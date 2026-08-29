# pi-kaggle

Kaggle integration for [pi](https://github.com/earendil-works/pi-coding-agent). Download datasets, submit predictions, manage notebooks, track leaderboards — all from your coding agent.

## Features

### Competition Workflow
- **`kaggle_competition_files`** — List available files before downloading
- **`kaggle_download`** — Download competition data or datasets (with unzip, force overwrite, single file options)
- **`kaggle_submit`** — Submit prediction CSVs or kernels (with `--wait` for scoring, code competition support)
- **`kaggle_submissions`** — View past submission history with scores
- **`kaggle_submission_status`** — Check status and score of a specific submission
- **`kaggle_leaderboard`** — View competition leaderboard (top scores or full CSV download)
- **`kaggle_topics`** — Browse competition discussion forums for insights

### Kernel (Notebook) Management — critical for code competitions
- **`kaggle_kernel_push`** — Push notebook/script + metadata to Kaggle and run remotely (with GPU/TPU accelerator support)
- **`kaggle_kernel_pull`** — Pull kernel source and metadata from Kaggle
- **`kaggle_kernel_status`** — Check if kernel run completed, is running, or failed
- **`kaggle_kernel_output`** — Download output files from latest kernel run (e.g. `submission.csv`)
- **`kaggle_kernel_init`** — Initialize `kernel-metadata.json` template
- **`kaggle_kernels_list`** — Search/list kernels with filters (language, type, competition, owner)

### Dataset Management
- **`kaggle_dataset_files`** — List individual files in a dataset before downloading
- **`kaggle_dataset_create`** — Create a new public/private dataset
- **`kaggle_dataset_version`** — Create a new version of an existing dataset
- **`kaggle_list`** — List/search competitions or datasets (with group, category, sort filters)
- **`kaggle_info`** — Get competition details or dataset metadata

### Configuration
- **`kaggle_config`** — View/set/unset Kaggle CLI config (e.g. default competition)

### Quick Commands
| Command | Description |
|---------|-------------|
| `/kaggle-setup` | Verify Kaggle CLI and API credentials |
| `/kaggle-competitions [filter]` | List competitions (filter: entered, general, etc.) |
| `/kaggle-datasets <term>` | Search datasets |
| `/kaggle-set <slug>` | Set active competition for this workspace |
| `/kaggle-status` | Show current workspace status |

### Session Awareness
- Remembers active competition, dataset, kernel, and last submission across sessions
- Injects Kaggle context into every agent turn for informed decision-making
- Shows active competition/kernel in session status bar

## Typical Workflow

### Standard Competition
1. `/kaggle-set titanic` — set active competition
2. LLM calls `kaggle_competition_files` → sees available files
3. LLM calls `kaggle_download` → fetches training/test data
4. LLM explores data, builds model, generates `submission.csv`
5. LLM calls `kaggle_submit` → uploads predictions
6. LLM calls `kaggle_leaderboard` → checks rank
7. LLM calls `kaggle_topics` — reads discussions for improvement ideas
8. Iterate: improve model → submit → check leaderboard

### Code Competition
1. `kaggle_download` → fetch competition data
2. Develop model locally
3. `kaggle_kernel_init` → create metadata
4. `kaggle_kernel_push --accelerator NvidiaTeslaT4` → push and run on Kaggle
5. `kaggle_kernel_status` → wait for completion
6. `kaggle_kernel_output --file-pattern ".*submission.*"` → download results
7. `kaggle_submit --kernel owner/kernel-slug --version 1` → submit kernel

## Prerequisites

- [Kaggle CLI](https://github.com/Kaggle/kaggle-api): `pip install kaggle`
- API credentials: `kaggle auth login` or put token in `~/.kaggle/access_token`

## Installation

```bash
git clone https://github.com/tkoyama010/pi-kaggle.git
cd pi-kaggle
npm install

# Global install — symlink to pi extensions dir
mkdir -p ~/.pi/agent/extensions
ln -s $(pwd)/src/index.ts ~/.pi/agent/extensions/pi-kaggle.ts
```

Or add to `settings.json`:
```json
{
  "extensions": ["/path/to/pi-kaggle/src/index.ts"]
}
```

## License

MIT
