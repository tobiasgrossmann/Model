# iOS App (App)

This folder contains an iPhone SwiftUI app scaffold for your local fitness trainer model.

## Features implemented

- Chat interface for model interaction
- Company logo badge (HEICO)
- About Us section
- Model + health data section
- Tool function implementation: `get_user_health_data()` via HealthKit
- RAG integration using markdown files in `RAG`
- Assistant reference chips that open source `.md` files in-app
- Markdown rendering (formatted, not raw)

## Project structure

- `FitCoachApp/` Swift source files
- `FitCoachApp/Resources/RAG/` bundled RAG docs
- `sync_rag_to_app.sh` helper to sync repository `rag/` documents

## Next steps in Xcode

1. Create a new iOS App project named `FitCoachApp` in this `App` folder.
2. Replace generated source files with files from `FitCoachApp/`.
3. Add `FitCoachApp/Resources/RAG` as a folder reference to app target resources.
4. Enable HealthKit capability in Signing & Capabilities.
5. Run with a local OpenAI-compatible model endpoint or replace `LocalOpenAIModelEngine` with your embedded runtime.

## Local RAG sync

Run from repo root:

```bash
bash App/sync_rag_to_app.sh
```
