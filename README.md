# pi-kaggle

Kaggle integration for [pi](https://github.com/earendil-works/pi-coding-agent). Download datasets, submit predictions, and track competitions — all from your coding agent.

## Features

- **Download datasets & competitions** — `kaggle_download` tool fetches data directly into your workspace
- **Submit predictions** — `kaggle_submit` tool uploads CSV submissions to competitions
- **Browse competitions & datasets** — `kaggle_list` tool searches and lists resources
- **Get competition info** — `kaggle_info` tool fetches rules, deadlines, and evaluation metrics
- **Session persistence** — remembers your active competition across sessions
- **Quick commands** — `/kaggle-setup`, `/kaggle-competitions`, `/kaggle-datasets`

## Prerequisites

- [Kaggle CLI](https://github.com/Kaggle/kaggle-api) installed: `pip install kaggle`
- Kaggle API credentials at `~/.kaggle/kaggle.json` (see [API setup](https://github.com/Kaggle/kaggle-api#api-credentials))

## Installation

```bash
# Clone and install deps
git clone https://github.com/YOUR_USERNAME/pi-kaggle.git
cd pi-kaggle
npm install

# For global use — symlink or copy to pi extensions dir
mkdir -p ~/.pi/agent/extensions
ln -s $(pwd)/src/index.ts ~/.pi/agent/extensions/pi-kaggle.ts
```

Or add to your `settings.json`:

```json
{
  "extensions": ["/path/to/pi-kaggle/src/index.ts"]
}
```

## Usage

### Tools (called by the LLM)

| Tool | Description |
|------|-------------|
| `kaggle_download` | Download a dataset or competition files |
| `kaggle_submit` | Submit a prediction CSV to a competition |
| `kaggle_list` | List/search competitions or datasets |
| `kaggle_info` | Get details about a competition or dataset |

### Commands

| Command | Description |
|---------|-------------|
| `/kaggle-setup` | Verify Kaggle API credentials and CLI installation |
| `/kaggle-competitions` | List active competitions |
| `/kaggle-datasets` | Search datasets by keyword |

### Example Flow

1. User: "Help me with the Titanic competition"
2. LLM calls `kaggle_info` → gets competition details
3. LLM calls `kaggle_download` → fetches training data
4. LLM explores data, builds model
5. LLM calls `kaggle_submit` → uploads predictions
6. Extension remembers the competition for next session

## License

MIT
